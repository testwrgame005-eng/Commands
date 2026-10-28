const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  StringSelectMenuBuilder,
  MessageFlags,
  REST,
  Routes,
  SlashCommandBuilder
} = require("discord.js");

const { Redis } = require("@upstash/redis");

// ================= CONFIGURACIÓN =================

const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;

const PANEL_CHANNEL_ID = "1494760619985862676";
const CHAMPION_ROLE_ID = "1486206362332434634";
const MAX_ONLINE_PER_GROUP = 25;

const CHANNEL_GROUP_MAP = {
  "1486277594629275770": "Elite_Four",
  "1487362022864588902": "Trainer",
  "1484015417411244082": "Gym_Leader"
};

const GROUP_CONFIG = {
  Trainer: { label: "Trainer" },
  Gym_Leader: { label: "Gym Leader" },
  Elite_Four: { label: "Elite Four" }
};

const RIVAL_DUOS_KEY = "rival_duos";
const RIVAL_DUO_BY_USER_KEY = "rival_duo_by_user";
const RIVAL_DUO_BY_GAMEID_KEY = "rival_duo_by_gameid";
const RIVAL_DUO_ROTATION_MS = 60 * 60 * 1000; // 1 hora

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN
});

// ================= CLAVES DE REDIS =================

const onlineKey = (group) => `online:${group}`;
const usersKey = (group) => `users:${group}`;
const vipKey = (group) => `vip:${group}`;
const schedulesKey = () => "daily_schedules";
const panelDataKey = () => "panel_data";
const activeRolesKey = () => "active_roles";
const rivalDuoPendingKey = (discordId) => `rival_duo_pending:${discordId}`;

// ================= PARSERS Y SANITIZACIÓN ANTI-CORRUPCIÓN =================

function safeJsonParse(value, fallback = null) {
  let v = value;

  for (let i = 0; i < 4; i++) {
    if (v === null || v === undefined || v === "") return fallback;
    if (typeof v === "object" && !Array.isArray(v)) return v;
    if (Array.isArray(v)) return v;
    if (typeof v !== "string") return fallback;

    const s = v
      .trim()
      .replace(/^\uFEFF/, "")
      .replace(/[“”]/g, '"')
      .replace(/[‘’]/g, "'")
      .replace(/,\s*([}\]])/g, "$1")
      .replace(/,\s*$/, "");

    try {
      v = JSON.parse(s);
    } catch (err) {
      console.error("❌ JSON corrupto detectado en Redis:", s.slice(0, 200));
      return fallback;
    }
  }

  return typeof v === "object" && v !== null ? v : fallback;
}

function cleanGameId(val) {
  if (val === null || val === undefined) return null;
  const digits = String(val).replace(/\D/g, "").trim();
  return /^\d{16}$/.test(digits) ? digits : null;
}

function isValidId(id) {
  return /^\d{16}$/.test(String(id || "").replace(/\s+/g, "").trim());
}

function isValidGameId(id) {
  return isValidId(id);
}

function uniqueList(arr) {
  if (!Array.isArray(arr)) return [];
  return [
    ...new Set(
      arr
        .map((x) => String(x || "").trim())
        .filter(Boolean)
    )
  ];
}

function normalizeUser(raw, fallbackName = "Unknown") {
  const parsed = safeJsonParse(raw, null);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;

  const name = String(parsed.name || parsed.displayName || fallbackName).trim() || "Unknown";
  const heartbeatName = String(parsed.heartbeatName || parsed.hb_name || name).trim() || name;

  const mainId = cleanGameId(parsed.main_id ?? parsed.mainId ?? parsed.id);
  const secId = cleanGameId(parsed.sec_id ?? parsed.secId);

  const aliases = uniqueList([
    ...(Array.isArray(parsed.aliases) ? parsed.aliases : []),
    name,
    heartbeatName
  ]);

  return {
    ...parsed,
    name,
    heartbeatName,
    aliases,
    main_id: mainId,
    sec_id: secId
  };
}

function buildUserData(oldRaw, interaction, updates = {}) {
  const discordName =
    interaction?.member?.displayName ||
    interaction?.user?.username ||
    "Unknown";

  const oldData = normalizeUser(oldRaw, discordName) || {};

  const finalMainId =
    updates.main_id !== undefined
      ? cleanGameId(updates.main_id)
      : cleanGameId(oldData.main_id);

  const finalSecId =
    updates.sec_id !== undefined
      ? cleanGameId(updates.sec_id)
      : cleanGameId(oldData.sec_id);

  const name = String(updates.name || oldData.name || discordName).trim();
  const heartbeatName = String(
    updates.heartbeatName || oldData.heartbeatName || name
  ).trim();

  const aliases = uniqueList([
    ...(Array.isArray(oldData.aliases) ? oldData.aliases : []),
    ...(Array.isArray(updates.aliases) ? updates.aliases : []),
    oldData.name,
    oldData.heartbeatName,
    discordName,
    name,
    heartbeatName
  ]);

  return {
    ...oldData,
    ...updates,
    name,
    heartbeatName,
    aliases,
    main_id: finalMainId,
    sec_id: finalSecId,
    updatedAt: Date.now()
  };
}

// ================= OPERACIONES ATÓMICAS DE USUARIOS EN REDIS =================

async function getUser(discordId, group) {
  if (!GROUP_CONFIG[group]) return null;
  try {
    const raw = await redis.hget(usersKey(group), String(discordId).trim());
    if (!raw) return null;
    return normalizeUser(raw);
  } catch (err) {
    console.error(`❌ Error leyendo usuario ${discordId} en ${group}:`, err);
    return null;
  }
}

async function saveSingleUser(discordId, userObj, group) {
  if (!discordId || !GROUP_CONFIG[group] || !userObj) return false;
  try {
    const cleanId = String(discordId).trim();
    const existing = await getUser(cleanId, group);
    const merged = normalizeUser({ ...(existing || {}), ...userObj });

    if (!merged) return false;

    await redis.hset(usersKey(group), {
      [cleanId]: JSON.stringify(merged)
    });
    return true;
  } catch (err) {
    console.error(`❌ Error guardando usuario ${discordId} en ${group}:`, err);
    return false;
  }
}

async function getUsers(group) {
  if (!GROUP_CONFIG[group]) return {};
  try {
    const data = await redis.hgetall(usersKey(group));
    if (!data || typeof data !== "object") return {};

    const users = {};
    for (const [uid, raw] of Object.entries(data)) {
      const user = normalizeUser(raw);
      if (!user) {
        console.warn(`⚠️ Registro omitido por formato inválido en ${usersKey(group)} -> ${uid}`);
        continue;
      }
      users[String(uid).trim()] = user;
    }
    return users;
  } catch (err) {
    console.error(`❌ Error cargando usuarios de ${group}:`, err);
    return {};
  }
}

// Verifica duplicados ÚNICAMENTE dentro del mismo grupo (permite el mismo ID en grupos distintos)
async function isGameIdAlreadyUsed(id, group, ignoreDiscordId = null) {
  const targetId = cleanGameId(id);
  if (!targetId || !GROUP_CONFIG[group]) return false;

  const users = await getUsers(group);
  for (const [uid, u] of Object.entries(users)) {
    if (ignoreDiscordId && String(uid) === String(ignoreDiscordId)) continue;
    if (u.main_id === targetId || u.sec_id === targetId) {
      return true;
    }
  }
  return false;
}

async function findUserRegistration(discordId, preferredGroup = null) {
  const allGroups = Object.keys(GROUP_CONFIG);
  const groups =
    preferredGroup && GROUP_CONFIG[preferredGroup]
      ? [preferredGroup, ...allGroups.filter((g) => g !== preferredGroup)]
      : allGroups;

  for (const group of groups) {
    const userData = await getUser(discordId, group);
    if (userData) {
      return { group, userData };
    }
  }
  return null;
}

// ================= GESTIÓN DE ROLES Y GRUPOS =================

function isChampion(interaction) {
  return (
    interaction.member?.roles?.cache?.has(CHAMPION_ROLE_ID) ||
    interaction.member?.roles?.cache?.some((r) => r.name === "Champion")
  );
}

function getGroupLabel(group) {
  const labels = {
    Trainer: "Trainer",
    Gym_Leader: "Gym Leader",
    Elite_Four: "Elite Four",
    Rival_Duo: "Rival Duo"
  };
  return labels[group] || group;
}

function buildGroupOptions() {
  return [
    { label: "Trainer", value: "Trainer" },
    { label: "Gym Leader", value: "Gym_Leader" },
    { label: "Elite Four", value: "Elite_Four" }
  ];
}

function normalizeSelectableRoleName(roleName) {
  const map = {
    Trainer: "Trainer",
    Gym_Leader: "Gym_Leader",
    "Gym Leader": "Gym_Leader",
    Elite_Four: "Elite_Four",
    "Elite Four": "Elite_Four",
    Rival_Duo: "Rival_Duo",
    "Rival Duo": "Rival_Duo"
  };
  return map[roleName] || null;
}

function getMemberSelectableRoles(member) {
  if (!member?.roles?.cache) return [];
  return member.roles.cache
    .map((role) => normalizeSelectableRoleName(role.name))
    .filter(Boolean)
    .filter((group, index, arr) => arr.indexOf(group) === index);
}

async function getActiveRole(userId) {
  try {
    const direct = await redis.get(`active_roles:${userId}`);
    if (direct && typeof direct === "string") return direct;

    const oldRoles = await redis.hgetall(activeRolesKey());
    if (oldRoles && typeof oldRoles === "object" && oldRoles[userId]) {
      return oldRoles[userId];
    }
    return null;
  } catch (err) {
    console.error("Error leyendo active_roles:", err);
    return null;
  }
}

async function setActiveRole(userId, role) {
  try {
    await redis.set(`active_roles:${userId}`, role);
    await redis.hset(activeRolesKey(), { [String(userId)]: role }).catch(() => {});
  } catch (err) {
    console.error("Error guardando active_role:", err);
  }
}

async function getUserGroup(interaction) {
  const memberGroups = getMemberSelectableRoles(interaction.member);
  if (!memberGroups.length) return null;

  const savedRole = await getActiveRole(interaction.user.id);
  if (savedRole && memberGroups.includes(savedRole)) {
    return savedRole;
  }

  const priority = ["Rival_Duo", "Elite_Four", "Gym_Leader", "Trainer"];
  for (const role of priority) {
    if (memberGroups.includes(role)) return role;
  }
  return null;
}

async function isActiveRivalDuo(interaction) {
  const hasRivalDuoRole = interaction.member?.roles?.cache?.some(
    (role) => role.name === "Rival_Duo" || role.name === "Rival Duo"
  );
  if (!hasRivalDuoRole) return false;
  return (await getUserGroup(interaction)) === "Rival_Duo";
}

// ================= ONLINE / OFFLINE Y VIP =================

function normalizeRedisIds(ids) {
  if (!Array.isArray(ids)) return [];
  return ids.map((id) => cleanGameId(id)).filter(Boolean);
}

async function getOnlineIDs(group) {
  if (!GROUP_CONFIG[group]) return [];
  try {
    const ids = await redis.smembers(onlineKey(group));
    return normalizeRedisIds(ids);
  } catch (err) {
    console.error(`getOnlineIDs error (${group}):`, err);
    return [];
  }
}

async function setOnlineStatus(action, id, group) {
  try {
    const clean = cleanGameId(id);
    if (!["online", "offline"].includes(action) || !clean || !GROUP_CONFIG[group]) {
      return false;
    }

    if (action === "online") {
      await redis.sadd(onlineKey(group), clean);
    } else {
      await redis.srem(onlineKey(group), clean);
    }
    return true;
  } catch (err) {
    console.error(`setOnlineStatus ${action} error:`, err);
    return false;
  }
}

async function addVipID(id, group) {
  try {
    const clean = cleanGameId(id);
    if (!clean || !GROUP_CONFIG[group]) return false;

    await redis.sadd(vipKey(group), clean);
    const nowTs = Math.floor(Date.now() / 1000);
    await redis.hset(`${vipKey(group)}:timestamps`, { [clean]: nowTs }).catch(() => {});

    console.log(`✅ VIP agregado a ${group}: ${clean}`);
    return true;
  } catch (err) {
    console.error("Error guardando VIP en Redis:", err);
    return false;
  }
}

function buildUserLabel(user, id) {
  if (!user) return `Unknown (${id})`;
  if (user.main_id === id) return `${user.name} (Main)`;
  if (user.sec_id === id) return `${user.name} (Sec)`;
  return `${user.name}`;
}

async function getOnlineUsersByGroup(group) {
  if (!GROUP_CONFIG[group]) return [];

  const onlineIds = await getOnlineIDs(group);
  if (!onlineIds.length) return [];

  const users = await getUsers(group);
  const results = [];

  const duos = await loadAllRivalDuos();
  const activeDuoIds = new Map();

  for (const duo of Object.values(duos)) {
    if (!duo) continue;
    if (duo.status === "online" && duo.activeGroup === group && duo.activeGameId) {
      activeDuoIds.set(String(duo.activeGameId), duo);
    }
  }

  for (const id of onlineIds) {
    if (activeDuoIds.has(String(id))) continue;

    let foundUser = null;
    for (const u of Object.values(users)) {
      if (u.main_id === id || u.sec_id === id) {
        foundUser = u;
        break;
      }
    }

    results.push({
      id,
      label: buildUserLabel(foundUser, id),
      user: foundUser,
      duoId: null
    });
  }

  for (const [id, duo] of activeDuoIds.entries()) {
    const activeMember = getRivalDuoMember(duo, duo.activeDiscordId);
    results.push({
      id,
      label: `🤝 Rival Duo: ${displayRivalDuoName(duo)}${activeMember ? ` (Active: ${activeMember.name})` : ""}`,
      user: null,
      duoId: duo.id,
      duo: true,
      activeMember
    });
  }

  return results;
}

// ================= SISTEMA RIVAL DUO (SOPORTE MULTI-DUO) =================

const createRivalDuoId = () => `duo_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const rivalNow = () => Date.now();

function getRivalDuoMembers(duo) {
  return Object.entries(duo?.members || {}).map(([discordId, member]) => ({
    discordId,
    ...member
  }));
}

function getRivalDuoMember(duo, discordId) {
  return duo?.members?.[String(discordId)] || null;
}

function isRivalDuoFull(duo) {
  return getRivalDuoMembers(duo).length >= 2;
}

function displayRivalDuoName(duo) {
  const members = getRivalDuoMembers(duo);
  if (!members.length) return "Empty Duo";
  return members.map((m) => m.name || m.heartbeatName || "Unknown").join(" & ");
}

function ensureRivalDuoGroupState(duo) {
  if (!duo.groupSelections || typeof duo.groupSelections !== "object") {
    duo.groupSelections = {};
  }
  if (!("activeGroup" in duo)) {
    duo.activeGroup = null;
  }
  return duo;
}

async function loadAllRivalDuos() {
  try {
    const data = await redis.hgetall(RIVAL_DUOS_KEY);
    if (!data || typeof data !== "object") return {};

    const out = {};
    for (const [duoId, raw] of Object.entries(data)) {
      const parsed = safeJsonParse(raw, null);
      if (parsed) out[duoId] = parsed;
    }
    return out;
  } catch (err) {
    console.error("Error cargando Rival Duos:", err);
    return {};
  }
}

async function saveRivalDuo(duo) {
  try {
    if (!duo?.id) return false;
    await redis.hset(RIVAL_DUOS_KEY, {
      [duo.id]: JSON.stringify(duo)
    });
    return true;
  } catch (err) {
    console.error("Error guardando Rival Duo:", err);
    return false;
  }
}

async function getRivalDuoById(duoId) {
  try {
    const raw = await redis.hget(RIVAL_DUOS_KEY, String(duoId));
    return safeJsonParse(raw, null);
  } catch (err) {
    console.error("Error leyendo Rival Duo por ID:", err);
    return null;
  }
}

async function getAllRivalDuosByUser(discordId) {
  const target = String(discordId);
  const duos = await loadAllRivalDuos();
  const found = [];

  for (const duo of Object.values(duos)) {
    if (duo?.members?.[target]) {
      found.push(duo);
    }
  }
  return found;
}

async function getRivalDuoByUser(discordId) {
  const duos = await getAllRivalDuosByUser(discordId);
  if (!duos.length) return null;
  // Priorizar un duo que esté online o completo
  return (
    duos.find((d) => d.status === "online") ||
    duos.find((d) => isRivalDuoFull(d)) ||
    duos[0]
  );
}

async function saveRivalDuoIndexes(duo) {
  try {
    for (const member of getRivalDuoMembers(duo)) {
      await redis.hset(RIVAL_DUO_BY_USER_KEY, {
        [member.discordId]: JSON.stringify({
          duoId: duo.id,
          discordId: member.discordId
        })
      });
      if (member.gameId) {
        await redis.hset(RIVAL_DUO_BY_GAMEID_KEY, {
          [member.gameId]: JSON.stringify({
            duoId: duo.id,
            discordId: member.discordId
          })
        });
      }
    }
    return true;
  } catch (err) {
    console.error("Error guardando índices de Rival Duo:", err);
    return false;
  }
}

async function findOpenRivalDuos() {
  const duos = await loadAllRivalDuos();
  return Object.values(duos)
    .filter(Boolean)
    .filter((duo) => !isRivalDuoFull(duo));
}

async function savePendingRivalDuoRegistration(discordId, data) {
  await redis.set(rivalDuoPendingKey(discordId), JSON.stringify(data), { ex: 600 });
}

async function loadPendingRivalDuoRegistration(discordId) {
  const raw = await redis.get(rivalDuoPendingKey(discordId));
  return safeJsonParse(raw, null);
}

async function clearPendingRivalDuoRegistration(discordId) {
  await redis.del(rivalDuoPendingKey(discordId));
}

async function registerRivalDuoMember({ discordId, name, heartbeatName, gameId, duoId = null }) {
  discordId = String(discordId);
  gameId = cleanGameId(gameId);
  duoId = duoId ? String(duoId) : null;

  if (!gameId) {
    return { ok: false, message: "❌ ID must be exactly 16 digits." };
  }

  let duo = null;

  if (duoId) {
    duo = await getRivalDuoById(duoId);
    if (!duo) return { ok: false, message: "❌ This Rival Duo no longer exists." };
    if (!duo.members || typeof duo.members !== "object") duo.members = {};
    if (duo.members[discordId]) {
      return { ok: false, message: "❌ You are already registered in this specific Rival Duo." };
    }
    if (isRivalDuoFull(duo)) {
      return { ok: false, message: "❌ This Rival Duo is already full." };
    }
  } else {
    duo = {
      id: createRivalDuoId(),
      createdAt: rivalNow(),
      members: {},
      onlineUsers: {},
      groupSelections: {},
      activeGroup: null,
      activeGameId: null,
      activeDiscordId: null,
      activeIndex: 0,
      lastRotationAt: 0,
      lastHeartbeatAt: {},
      lastHeartbeatStats: {},
      status: "waiting",
      offlineReason: null,
      offlineAt: null
    };
  }

  duo.members[discordId] = {
    discordId,
    name: name || "Unknown",
    heartbeatName: heartbeatName || name || "Unknown",
    gameId,
    aliases: uniqueList([name, heartbeatName]),
    joinedAt: rivalNow()
  };

  const saved = await saveRivalDuo(duo);
  if (!saved) return { ok: false, message: "❌ Could not save Rival Duo in Redis." };

  await saveRivalDuoIndexes(duo);

  if (isRivalDuoFull(duo)) {
    return {
      ok: true,
      message: `✅ Rival Duo completed: **${displayRivalDuoName(duo)}**.`
    };
  }

  return {
    ok: true,
    message: "✅ Rival Duo created. Waiting for your reroll partner."
  };
}

async function removeRivalDuoIdsFromGroups(duo) {
  const ids = getRivalDuoMembers(duo)
    .map((m) => cleanGameId(m.gameId))
    .filter(Boolean);

  if (!ids.length) return;
  await redis.srem("online:Elite_Four", ...ids);
  await redis.srem("online:Gym_Leader", ...ids);
}

async function getRivalDuoSelectedGroup(duo) {
  ensureRivalDuoGroupState(duo);
  const members = getRivalDuoMembers(duo);

  if (members.length < 2) return { ok: false, reason: "waiting_partner" };

  const firstGroup = duo.groupSelections[members[0].discordId];
  const secondGroup = duo.groupSelections[members[1].discordId];

  if (!firstGroup || !secondGroup) return { ok: false, reason: "waiting_selection" };
  if (firstGroup !== secondGroup) {
    return { ok: false, reason: "selection_mismatch", firstGroup, secondGroup };
  }

  return { ok: true, group: firstGroup };
}

async function getOnlineUserCountExcludingDuo(group, duoId = null) {
  const onlineIds = await getOnlineIDs(group);
  if (!duoId) return onlineIds.length;

  const duo = await getRivalDuoById(duoId);
  if (!duo) return onlineIds.length;

  const duoIds = getRivalDuoMembers(duo)
    .map((m) => cleanGameId(m.gameId))
    .filter(Boolean);

  return onlineIds.filter((id) => !duoIds.includes(id)).length;
}

function buildRivalDuoGroupMenu(duo, discordId) {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`rival_duo_group_select_${duo.id}_${discordId}`)
    .setPlaceholder(`Select group for ${displayRivalDuoName(duo).slice(0, 50)}`)
    .addOptions([
      {
        label: "Elite Four",
        description: "Join the Elite Four group",
        value: "Elite_Four"
      },
      {
        label: "Gym Leader",
        description: "Join the Gym Leader group",
        value: "Gym_Leader"
      }
    ]);

  return new ActionRowBuilder().addComponents(menu);
}

async function activateRivalDuoId(duo, force = false) {
  ensureRivalDuoGroupState(duo);
  const members = getRivalDuoMembers(duo);

  if (members.length < 2) {
    await removeRivalDuoIdsFromGroups(duo);
    duo.activeGameId = null;
    duo.activeDiscordId = null;
    duo.activeGroup = null;
    duo.status = "waiting_partner";
    await saveRivalDuo(duo);
    return { ok: false, waiting: true, message: "⏳ Waiting for reroll partner." };
  }

  if (!duo.onlineUsers || typeof duo.onlineUsers !== "object") {
    duo.onlineUsers = {};
  }

  const allOnline = members.every((m) => duo.onlineUsers[m.discordId] === true);
  if (!allOnline) {
    await removeRivalDuoIdsFromGroups(duo);
    duo.activeGameId = null;
    duo.activeDiscordId = null;
    duo.activeGroup = null;
    duo.status = "offline";
    await saveRivalDuo(duo);
    return { ok: false, waiting: false, message: "🔴 Rival Duo offline." };
  }

  const selection = await getRivalDuoSelectedGroup(duo);
  if (!selection.ok) {
    await removeRivalDuoIdsFromGroups(duo);
    duo.activeGameId = null;
    duo.activeDiscordId = null;
    duo.activeGroup = null;
    duo.status = selection.reason;
    await saveRivalDuo(duo);

    if (selection.reason === "waiting_selection") {
      return {
        ok: false,
        waiting: true,
        message: "⏳ Both members must select the same group (**Elite Four** or **Gym Leader**)."
      };
    }

    return {
      ok: false,
      waiting: true,
      message: "⚠️ Your Rival Duo members selected different groups. Both must select the **same group**."
    };
  }

  const selectedGroup = selection.group;
  const onlineCount = await getOnlineUserCountExcludingDuo(selectedGroup, duo.id);

  if (onlineCount >= MAX_ONLINE_PER_GROUP) {
    await removeRivalDuoIdsFromGroups(duo);
    duo.activeGameId = null;
    duo.activeDiscordId = null;
    duo.activeGroup = selectedGroup;
    duo.status = "waiting_capacity";
    await saveRivalDuo(duo);

    return {
      ok: false,
      waiting: true,
      full: true,
      group: selectedGroup,
      message: `⚠️ The **${getGroupLabel(selectedGroup)}** group is full (**${MAX_ONLINE_PER_GROUP}/${MAX_ONLINE_PER_GROUP}**).\nYour Rival Duo remains **online** waiting for a free slot.`
    };
  }

  const now = rivalNow();
  const shouldRotate =
    force ||
    !duo.lastRotationAt ||
    now - Number(duo.lastRotationAt || 0) >= RIVAL_DUO_ROTATION_MS;

  if (!duo.activeGameId || shouldRotate) {
    if (!duo.cededUsers) duo.cededUsers = {};

    let index = Number(duo.activeIndex || 0) % members.length;
    let activeMember = members[index];

    if (duo.cededUsers[activeMember.discordId] === true) {
      index = (index + 1) % members.length;
      activeMember = members[index];

      if (duo.cededUsers[activeMember.discordId] === true) {
        await removeRivalDuoIdsFromGroups(duo);
        duo.activeGameId = null;
        duo.activeDiscordId = null;
        duo.activeGroup = selectedGroup;
        duo.status = "idle";
        await saveRivalDuo(duo);

        return {
          ok: false,
          waiting: false,
          message: "⚫ Both members have yielded their reroll. Duo is idle."
        };
      }
    }

    await removeRivalDuoIdsFromGroups(duo);

    duo.activeGameId = activeMember.gameId;
    duo.activeDiscordId = activeMember.discordId;
    duo.activeGroup = selectedGroup;
    duo.lastRotationAt = now;
    duo.activeIndex = (index + 1) % members.length;
    duo.status = "online";

    await redis.sadd(onlineKey(selectedGroup), activeMember.gameId);
    await saveRivalDuo(duo);

    return {
      ok: true,
      waiting: false,
      message:
        `🟢 Rival Duo **${displayRivalDuoName(duo)}** online in **${getGroupLabel(selectedGroup)}**.\n` +
        `Active ID: \`${activeMember.gameId}\`\n` +
        `Active user: <@${activeMember.discordId}>`
    };
  }

  if (duo.activeGameId && duo.activeGroup) {
    await redis.sadd(onlineKey(duo.activeGroup), duo.activeGameId);
  }
  duo.status = "online";
  await saveRivalDuo(duo);

  return {
    ok: true,
    waiting: false,
    message:
      `🟢 Rival Duo **${displayRivalDuoName(duo)}** already online in **${getGroupLabel(duo.activeGroup)}**.\n` +
      `Active ID: \`${duo.activeGameId}\`\n` +
      `Active user: <@${duo.activeDiscordId}>`
  };
}

async function setRivalDuoOnline(discordId) {
  discordId = String(discordId);
  const userDuos = await getAllRivalDuosByUser(discordId);

  if (!userDuos.length) {
    return { ok: false, message: "❌ You are not registered in any Rival Duo." };
  }

  for (const duo of userDuos) {
    ensureRivalDuoGroupState(duo);
    if (!duo.onlineUsers || typeof duo.onlineUsers !== "object") {
      duo.onlineUsers = {};
    }
    duo.onlineUsers[discordId] = true;
    await saveRivalDuo(duo);
  }

  const names = userDuos.map((d) => `**${displayRivalDuoName(d)}**`).join(", ");

  return {
    ok: true,
    duos: userDuos,
    duo: userDuos[0],
    message:
      `🤝 ${names}\n` +
      `You are now marked as **online**.\n\n` +
      `Select the group where your Duo wants to reroll:`
  };
}

async function selectRivalDuoGroup(discordId, selectedGroup, duoId) {
  discordId = String(discordId);

  if (!["Elite_Four", "Gym_Leader"].includes(selectedGroup)) {
    return { ok: false, message: "❌ Invalid Rival Duo group." };
  }

  const duo = duoId ? await getRivalDuoById(duoId) : await getRivalDuoByUser(discordId);
  if (!duo) {
    return { ok: false, message: "❌ Rival Duo not found." };
  }

  ensureRivalDuoGroupState(duo);
  const members = getRivalDuoMembers(duo);

  if (members.length < 2) {
    return { ok: false, message: "⏳ Your Rival Duo is still waiting for its second member." };
  }

  if (!duo.onlineUsers || duo.onlineUsers[discordId] !== true) {
    return { ok: false, message: "❌ You must set yourself ONLINE first." };
  }

  duo.groupSelections[discordId] = selectedGroup;
  await saveRivalDuo(duo);

  const otherMember = members.find((m) => String(m.discordId) !== discordId);
  const otherSelection = otherMember ? duo.groupSelections[otherMember.discordId] : null;

  if (!otherSelection) {
    return {
      ok: true,
      waiting: true,
      duo,
      message: `✅ You selected **${getGroupLabel(selectedGroup)}** for **${displayRivalDuoName(duo)}**.\n⏳ Waiting for your partner to select a group.`
    };
  }

  if (otherSelection !== selectedGroup) {
    duo.activeGameId = null;
    duo.activeDiscordId = null;
    duo.activeGroup = null;
    duo.status = "selection_mismatch";

    await removeRivalDuoIdsFromGroups(duo);
    await saveRivalDuo(duo);

    return {
      ok: true,
      mismatch: true,
      duo,
      message:
        `⚠️ **Group selection mismatch (${displayRivalDuoName(duo)}).**\n\n` +
        `You selected **${getGroupLabel(selectedGroup)}**.\n` +
        `Your partner selected **${getGroupLabel(otherSelection)}**.\n\n` +
        `Both members must select the **same group**.`
    };
  }

  const result = await activateRivalDuoId(duo, true);
  return {
    ok: result.ok,
    waiting: result.waiting,
    full: result.full || false,
    duo,
    message: result.message
  };
}

async function setRivalDuoOffline(discordId, reason = "offline") {
  discordId = String(discordId);
  const userDuos = await getAllRivalDuosByUser(discordId);

  if (!userDuos.length) {
    return { ok: false, message: "❌ You are not registered in any Rival Duo." };
  }

  const messages = [];

  for (const duo of userDuos) {
    await removeRivalDuoIdsFromGroups(duo);
    if (!duo.onlineUsers || typeof duo.onlineUsers !== "object") {
      duo.onlineUsers = {};
    }
    duo.onlineUsers[discordId] = false;
    duo.activeGroup = null;
    duo.activeGameId = null;
    duo.activeDiscordId = null;
    duo.status = "offline";
    duo.offlineReason = reason;
    duo.offlineAt = rivalNow();

    await saveRivalDuo(duo);
    messages.push(`🔴 Rival Duo offline: **${displayRivalDuoName(duo)}**.`);
  }

  return { ok: true, message: messages.join("\n") };
}

async function changeRivalDuoGameId(discordId, newGameId) {
  discordId = String(discordId);
  newGameId = cleanGameId(newGameId);

  if (!newGameId) {
    return { ok: false, message: "❌ ID must be exactly 16 digits." };
  }

  const userDuos = await getAllRivalDuosByUser(discordId);
  if (!userDuos.length) {
    return { ok: false, message: "❌ You are not registered in any Rival Duo." };
  }

  let oldGameId = null;

  for (const duo of userDuos) {
    const member = getRivalDuoMember(duo, discordId);
    if (!member) continue;

    oldGameId = cleanGameId(member.gameId);

    if (oldGameId && oldGameId !== newGameId) {
      await redis.srem("online:Elite_Four", oldGameId);
      await redis.srem("online:Gym_Leader", oldGameId);
      if (typeof redis.hdel === "function") {
        await redis.hdel(RIVAL_DUO_BY_GAMEID_KEY, oldGameId).catch(() => {});
      }
    }

    member.gameId = newGameId;
    member.updatedAt = rivalNow();
    duo.members[discordId] = member;

    if (String(duo.activeDiscordId || "") === discordId) {
      duo.activeGameId = newGameId;
      duo.lastRotationAt = rivalNow();
      if (duo.status === "online" && duo.activeGroup) {
        await redis.sadd(onlineKey(duo.activeGroup), newGameId);
      }
    }

    await saveRivalDuo(duo);
    await saveRivalDuoIndexes(duo);
  }

  return {
    ok: true,
    message:
      `🔄 Rival Duo ID updated across **${userDuos.length}** Duo(s).\n` +
      `Old ID: \`${oldGameId || "None"}\`\n` +
      `New ID: \`${newGameId}\``
  };
}

async function toggleCedeReroll(discordId) {
  discordId = String(discordId);
  const userDuos = await getAllRivalDuosByUser(discordId);

  if (!userDuos.length) {
    return { ok: false, message: "❌ You are not registered in any active Rival Duo." };
  }

  let newState = false;

  for (const duo of userDuos) {
    if (!duo.cededUsers) duo.cededUsers = {};
    const isCeded = duo.cededUsers[discordId] === true;
    newState = !isCeded;
    duo.cededUsers[discordId] = newState;

    await saveRivalDuo(duo);

    if (newState && String(duo.activeDiscordId) === discordId) {
      await activateRivalDuoId(duo, true);
    }
  }

  const msg = newState
    ? "⚠️ **You have yielded your reroll**. Your ID will be skipped during hourly rotations, keeping your partner active (Solo Mode)."
    : "✅ **You have reclaimed your reroll**. Your ID will now participate in the normal hourly rotation again.";

  return { ok: true, message: msg };
}

async function tickRivalDuoRotation() {
  const duos = await loadAllRivalDuos();
  for (const duo of Object.values(duos)) {
    if (!duo) continue;
    if (!["online", "waiting_capacity"].includes(duo.status)) continue;
    await activateRivalDuoId(duo, false);
  }
}

function formatRivalDuoTime(ms) {
  ms = Math.max(0, Number(ms) || 0);
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function getRivalDuoStatusLabel(duo) {
  const members = getRivalDuoMembers(duo);
  if (members.length < 2) return "⏳ Waiting Partner";

  const bothOnline = members.every((m) => duo.onlineUsers?.[m.discordId] === true);
  if (duo.status === "online" && bothOnline && duo.activeGameId) return "🟢 Online";
  if (!bothOnline) return "⏳ Waiting Both Online";
  if (duo.status === "waiting_capacity") return "🟡 Waiting Capacity";
  return "🔴 Offline";
}

async function buildRivalDuoListMessage() {
  const duos = await loadAllRivalDuos();
  const list = Object.values(duos).filter(Boolean);

  if (!list.length) return "📭 No Rival Duos registered.";

  let msg = "🤝 **Rival Duo List**\n\n";
  let index = 1;

  for (const duo of list) {
    const members = getRivalDuoMembers(duo);
    const status = getRivalDuoStatusLabel(duo);

    const activeMember = members.find((m) => String(m.discordId) === String(duo.activeDiscordId));
    const nextMember = members.find((m) => String(m.discordId) !== String(duo.activeDiscordId));

    let elapsedText = "0s";
    let remainingText = "Not active";

    if (duo.status === "online" && duo.activeGameId && duo.lastRotationAt) {
      const elapsed = Date.now() - Number(duo.lastRotationAt || 0);
      const remaining = Math.max(0, RIVAL_DUO_ROTATION_MS - elapsed);
      elapsedText = formatRivalDuoTime(elapsed);
      remainingText = formatRivalDuoTime(remaining);
    }

    msg += `**#${index} — ${displayRivalDuoName(duo)}** ${duo.activeGroup ? `*(${getGroupLabel(duo.activeGroup)})*` : ""}\n`;
    msg += `Status: ${status}\n`;

    for (let i = 0; i < 2; i++) {
      const m = members[i];
      const tag = i === 0 ? "User A" : "User B";
      if (m) {
        const icon = duo.onlineUsers?.[m.discordId] ? "🟢" : "🔴";
        const yielded = duo.cededUsers?.[m.discordId] ? " 🚫 *(Yielded)*" : "";
        msg += `${icon} ${tag}: <@${m.discordId}> | ID: \`${m.gameId}\`${yielded}\n`;
      } else {
        msg += `⚫ ${tag}: Empty\n`;
      }
    }

    if (duo.activeGameId) {
      msg += `Active ID: \`${duo.activeGameId}\` (${activeMember ? `<@${activeMember.discordId}>` : "Unknown"})\n`;
      msg += `Time: **${elapsedText}** elapsed | **${remainingText}** left\n`;
      msg += `Next: ${nextMember ? `<@${nextMember.discordId}> (\`${nextMember.gameId}\`)` : "Unknown"}\n`;
    } else {
      msg += `Active ID: None\n`;
    }

    msg += "\n";
    index++;
  }

  if (msg.length > 1900) {
    msg = msg.slice(0, 1850) + "\n\n⚠️ List truncated due to Discord length limit.";
  }

  return msg;
}

// ================= SCHEDULER DIARIO (ÚNICO) =================

async function loadSchedules() {
  try {
    const data = await redis.get(schedulesKey());
    return safeJsonParse(data, {});
  } catch (err) {
    console.error("Error loading schedules:", err);
    return {};
  }
}

async function saveSchedules(data) {
  try {
    await redis.set(schedulesKey(), JSON.stringify(data || {}));
  } catch (err) {
    console.error("Error saving schedules:", err);
  }
}

function startDailyScheduler() {
  setInterval(async () => {
    try {
      const schedules = await loadSchedules();
      const now = new Date();
      const utcHour = now.getUTCHours();
      const utcMinute = now.getUTCMinutes();
      const todayUTC = now.toISOString().slice(0, 10);

      let changed = false;

      for (const userId in schedules) {
        const s = schedules[userId];
        if (!s?.group || !s?.main_id) continue;

        if (
          s.online_hour === utcHour &&
          s.online_minute === utcMinute &&
          s.last_online !== todayUTC
        ) {
          const ok = await setOnlineStatus("online", s.main_id, s.group);
          if (ok) {
            s.last_online = todayUTC;
            changed = true;
            console.log("🟢 Scheduled ONLINE:", s.main_id, s.group);
          }
        }

        if (
          s.offline_hour === utcHour &&
          s.offline_minute === utcMinute &&
          s.last_offline !== todayUTC
        ) {
          const ok = await setOnlineStatus("offline", s.main_id, s.group);
          if (ok) {
            s.last_offline = todayUTC;
            changed = true;
            console.log("🔴 Scheduled OFFLINE:", s.main_id, s.group);
          }
        }
      }

      if (changed) await saveSchedules(schedules);
    } catch (err) {
      console.error("Scheduler error:", err);
    }
  }, 60 * 1000);
}

// ================= PANEL DE CONTROL VISUAL =================

async function loadPanelData() {
  try {
    const data = await redis.get(panelDataKey());
    return safeJsonParse(data, {});
  } catch {
    return {};
  }
}

async function savePanelData(data) {
  try {
    await redis.set(panelDataKey(), JSON.stringify(data || {}));
  } catch (err) {
    console.error("Error guardando panel_data:", err);
  }
}

async function sendPanel(channel) {
  if (!channel) return;
  const panelData = await loadPanelData();

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle("⚡ ZENITH REROLL — CONTROL CENTER")
    .setDescription(
      "Manage your reroll accounts, online status, schedules, and Rival Duo rotations directly from this panel or via Slash Commands.\n\n" +
      "🟢 **Status Controls:** Set your Main or Secondary IDs Online/Offline\n" +
      "🆔 **Account Setup:** Register IDs, update your Heartbeat Name, or switch groups\n" +
      "🤝 **Rival Duo:** Register Duos, check rotation timers, or toggle Solo Mode (*Yield*)"
    )
    .setFooter({ text: "All interactions are private (Ephemeral)" });

  // Fila 1: Estado Online / Offline (Lo más usado arriba)
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("online").setLabel("Online").setEmoji("🟢").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("offline").setLabel("Offline").setEmoji("🔴").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("online_sec").setLabel("Online Sec").setEmoji("⚡").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("online_list").setLabel("Online List").setEmoji("📡").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("list").setLabel("Registered List").setEmoji("📋").setStyle(ButtonStyle.Secondary)
  );

  // Fila 2: Gestión de Cuenta e IDs
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("register").setLabel("Register Main").setEmoji("🆔").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("add_sec").setLabel("Add Secondary").setEmoji("➕").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("change").setLabel("Change ID").setEmoji("🔄").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("heartbeat_name").setLabel("Heartbeat Name").setEmoji("🏷️").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("change_role").setLabel("Switch Group").setEmoji("🎭").setStyle(ButtonStyle.Primary)
  );

  // Fila 3: Sistema Rival Duo
  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("register_duo").setLabel("Register Duo").setEmoji("🤝").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("duo_list").setLabel("Duo Status & Timers").setEmoji("📊").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("cede_reroll").setLabel("Yield Reroll (Solo Mode)").setEmoji("⏭️").setStyle(ButtonStyle.Danger)
  );

  // Fila 4: Automatización y Herramientas Champion (Staff)
  const row4 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("schedule").setLabel("Auto Schedule (UTC)").setEmoji("⏰").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("gp").setLabel("Add VIP ID").setEmoji("👑").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("set_offline").setLabel("Force Offline").setEmoji("🛡️").setStyle(ButtonStyle.Danger)
  );

  const panelPayload = {
    embeds: [embed],
    components: [row1, row2, row3, row4]
  };

  try {
    if (panelData.messageId) {
      const msg = await channel.messages.fetch(panelData.messageId);
      await msg.edit(panelPayload);
      console.log("♻️ Panel de botones actualizado");
      return;
    }
  } catch {
    console.log("Panel anterior no encontrado, enviando uno nuevo...");
  }

  const newMsg = await channel.send(panelPayload);
  panelData.messageId = newMsg.id;
  await savePanelData(panelData);
  console.log("✅ Nuevo panel de botones creado");
}

// ================= LÓGICA COMPARTIDA (COMANDOS + BOTONES) =================

async function handleRegisterMain(interaction, rawId) {
  const group = await getUserGroup(interaction);
  if (!group || !GROUP_CONFIG[group]) {
    return "❌ You must have a valid group role (**Trainer**, **Gym Leader**, or **Elite Four**).";
  }

  const id = cleanGameId(rawId);
  if (!id) return "❌ ID must be exactly 16 digits.";

  if (await isGameIdAlreadyUsed(id, group, interaction.user.id)) {
    return `❌ ID \`${id}\` is already registered by another user in **${getGroupLabel(group)}**.`;
  }

  const oldData = await getUser(interaction.user.id, group);
  const newUserData = buildUserData(oldData, interaction, {
    main_id: id,
    sec_id: oldData?.sec_id || null
  });

  const saved = await saveSingleUser(interaction.user.id, newUserData, group);
  if (!saved) return "❌ Error saving your registration in Redis.";

  return (
    `✅ **Main ID registered in ${getGroupLabel(group)}**\n` +
    `🆔 Main ID: \`${newUserData.main_id}\`\n` +
    `👤 Display Name: **${newUserData.name}**\n` +
    `📡 Heartbeat Name: **${newUserData.heartbeatName}**`
  );
}

async function handleAddSecondary(interaction, rawSecId) {
  const group = await getUserGroup(interaction);
  if (!group || !GROUP_CONFIG[group]) return "❌ No valid group detected.";

  const secId = cleanGameId(rawSecId);
  if (!secId) return "❌ Secondary ID must be exactly 16 digits.";

  if (await isGameIdAlreadyUsed(secId, group, interaction.user.id)) {
    return `❌ ID \`${secId}\` is already registered by another user in **${getGroupLabel(group)}**.`;
  }

  const oldData = await getUser(interaction.user.id, group);
  if (!oldData?.main_id) {
    return "❌ You must register your Main ID first.";
  }

  const newUserData = buildUserData(oldData, interaction, { sec_id: secId });
  const saved = await saveSingleUser(interaction.user.id, newUserData, group);
  if (!saved) return "❌ Error saving secondary ID in Redis.";

  return `✅ Secondary ID \`${secId}\` added in **${getGroupLabel(group)}**.`;
}

async function handleChangeMainId(interaction, rawNewId) {
  const newId = cleanGameId(rawNewId);
  if (!newId) return "❌ ID must be exactly 16 digits.";

  const group = await getUserGroup(interaction);
  if (!group) return "❌ No active group detected.";

  if (group === "Rival_Duo" || (await isActiveRivalDuo(interaction))) {
    const res = await changeRivalDuoGameId(interaction.user.id, newId);
    return res.message;
  }

  if (await isGameIdAlreadyUsed(newId, group, interaction.user.id)) {
    return `❌ ID \`${newId}\` is already being used by another user in **${getGroupLabel(group)}**.`;
  }

  const oldData = await getUser(interaction.user.id, group);
  if (!oldData?.main_id) {
    return "❌ You must register first before changing your ID.";
  }

  if (oldData.main_id && oldData.main_id !== newId) {
    await setOnlineStatus("offline", oldData.main_id, group);
  }

  const updated = buildUserData(oldData, interaction, {
    main_id: newId,
    sec_id: oldData.sec_id || null
  });

  const saved = await saveSingleUser(interaction.user.id, updated, group);
  if (!saved) return "❌ Error updating your ID in Redis.";

  return (
    `🔄 **Main ID updated in ${getGroupLabel(group)}**\n` +
    `🆔 New ID: \`${updated.main_id}\`\n` +
    `👤 Display Name: **${updated.name}**\n` +
    `📡 Heartbeat Name: **${updated.heartbeatName}**`
  );
}

async function handleUpdateHeartbeatName(interaction, rawHbName) {
  const hbName = String(rawHbName || "").trim();
  if (!hbName) return "❌ Invalid heartbeat name.";

  const group = await getUserGroup(interaction);
  if (!group) return "❌ No group detected.";

  // Si es Rival Duo, actualizar también en sus Duos registrados
  if (group === "Rival_Duo") {
    const duos = await getAllRivalDuosByUser(interaction.user.id);
    if (!duos.length) return "❌ You are not registered in any Rival Duo.";

    for (const duo of duos) {
      const m = duo.members?.[interaction.user.id];
      if (!m) continue;
      m.heartbeatName = hbName;
      m.aliases = uniqueList([...(m.aliases || []), m.name, hbName]);
      await saveRivalDuo(duo);
    }

    return `✅ Rival Duo Heartbeat Name updated to **${hbName}**.`;
  }

  const oldData = await getUser(interaction.user.id, group);
  if (!oldData?.main_id) {
    return "❌ You must register your Main ID first.";
  }

  const updated = buildUserData(oldData, interaction, {
    heartbeatName: hbName
  });

  const saved = await saveSingleUser(interaction.user.id, updated, group);
  if (!saved) return "❌ Error saving heartbeat name in Redis.";

  return (
    `✅ **Heartbeat Name updated in ${getGroupLabel(group)}**\n` +
    `👤 Display Name: **${updated.name}**\n` +
    `📡 Heartbeat Name: **${updated.heartbeatName}**`
  );
}

// ================= REGISTRO DE SLASH COMMANDS =================

async function registerSlashCommands() {
  const commands = [
    new SlashCommandBuilder()
      .setName("register")
      .setDescription("Register your main game ID")
      .addStringOption((o) => o.setName("id").setDescription("Your 16 digit main ID").setRequired(true)),
    new SlashCommandBuilder()
      .setName("change")
      .setDescription("Change your main game ID")
      .addStringOption((o) => o.setName("id").setDescription("New 16 digit ID").setRequired(true)),
    new SlashCommandBuilder()
      .setName("add_sec")
      .setDescription("Register your secondary game ID")
      .addStringOption((o) => o.setName("id").setDescription("Your 16 digit secondary ID").setRequired(true)),
    new SlashCommandBuilder()
      .setName("heartbeat_name")
      .setDescription("Set your exact heartbeat name")
      .addStringOption((o) => o.setName("name").setDescription("Exact name shown in your heartbeat").setRequired(true)),
    new SlashCommandBuilder()
      .setName("register_duo")
      .setDescription("Register as a Rival Duo member")
      .addStringOption((o) => o.setName("id").setDescription("Your 16 digit Rival Duo ID").setRequired(true))
      .addStringOption((o) => o.setName("heartbeat_name").setDescription("Exact name shown in your heartbeat").setRequired(true)),
    new SlashCommandBuilder()
      .setName("duo_list")
      .setDescription("Show all Rival Duos and their active rotation status"),
    new SlashCommandBuilder()
      .setName("yield_reroll")
      .setDescription("Toggle Solo Mode by yielding or reclaiming your active reroll slot"),
    new SlashCommandBuilder()
      .setName("change_rol")
      .setDescription("Select your active reroll group"),
    new SlashCommandBuilder()
      .setName("online")
      .setDescription("Set your main account online"),
    new SlashCommandBuilder()
      .setName("online_sec")
      .setDescription("Set your secondary account online"),
    new SlashCommandBuilder()
      .setName("offline")
      .setDescription("Set your accounts offline"),
    new SlashCommandBuilder()
      .setName("list")
      .setDescription("List registered users in your group"),
    new SlashCommandBuilder()
      .setName("online_list")
      .setDescription("List online users in your group"),
    new SlashCommandBuilder()
      .setName("online_count")
      .setDescription("Shows how many users are online in each group"),
    new SlashCommandBuilder()
      .setName("schedule_events")
      .setDescription("Daily online/offline scheduler (UTC)")
      .addStringOption((opt) =>
        opt
          .setName("mode")
          .setDescription("Start or Stop")
          .setRequired(true)
          .addChoices(
            { name: "Start Daily Schedule", value: "start" },
            { name: "Stop All Schedules", value: "stop" }
          )
      )
      .addIntegerOption((opt) => opt.setName("online_hour").setDescription("Online Hour (UTC 0-23)"))
      .addIntegerOption((opt) => opt.setName("online_minute").setDescription("Online Minute (0-59)"))
      .addIntegerOption((opt) => opt.setName("offline_hour").setDescription("Offline Hour (UTC 0-23)"))
      .addIntegerOption((opt) => opt.setName("offline_minute").setDescription("Offline Minute (0-59)")),
    new SlashCommandBuilder()
      .setName("set_offline")
      .setDescription("Force a user offline (Champion only)"),
    new SlashCommandBuilder()
      .setName("add_vip")
      .setDescription("Add VIP ID (Champion only)")
      .addStringOption((o) => o.setName("id").setDescription("16 digit VIP ID").setRequired(true))
  ].map((cmd) => cmd.toJSON());

  if (!CLIENT_ID || !GUILD_ID) return;

  try {
    const rest = new REST({ version: "10" }).setToken(TOKEN);
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
    console.log("✅ Slash commands registrados correctamente");
  } catch (err) {
    console.error("❌ Error registrando slash commands:", err);
  }
}

// ================= EVENTO READY =================

let rivalRotationRunning = false;

client.once("clientReady", async () => {
  console.log(`✅ Bot unificado listo como ${client.user.tag}`);

  await registerSlashCommands();

  try {
    const ch = await client.channels.fetch(PANEL_CHANNEL_ID).catch(() => null);
    if (ch) await sendPanel(ch);
  } catch (err) {
    console.error("Error enviando panel inicial:", err);
  }

  startDailyScheduler();

  setInterval(async () => {
    if (rivalRotationRunning) return;
    rivalRotationRunning = true;
    try {
      await tickRivalDuoRotation();
    } catch (err) {
      console.error("Rival Duo rotation error:", err);
    } finally {
      rivalRotationRunning = false;
    }
  }, 60 * 1000);
});

// ================= MANEJADOR UNIFICADO DE INTERACCIONES =================

client.on("interactionCreate", async (interaction) => {
  try {
    // ---------------------------------------------------------
    // 1. SLASH COMMANDS
    // ---------------------------------------------------------
    if (interaction.isChatInputCommand()) {
      const { commandName } = interaction;

      if (commandName === "register") {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const msg = await handleRegisterMain(interaction, interaction.options.getString("id"));
        return interaction.editReply(msg);
      }

      if (commandName === "add_sec") {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const msg = await handleAddSecondary(interaction, interaction.options.getString("id"));
        return interaction.editReply(msg);
      }

      if (commandName === "change") {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const msg = await handleChangeMainId(interaction, interaction.options.getString("id"));
        return interaction.editReply(msg);
      }

      if (commandName === "heartbeat_name") {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const msg = await handleUpdateHeartbeatName(interaction, interaction.options.getString("name"));
        return interaction.editReply(msg);
      }

      if (commandName === "register_duo") {
        const hasRole = interaction.member?.roles?.cache?.some(
          (r) => r.name === "Rival_Duo" || r.name === "Rival Duo"
        );
        if (!hasRole) {
          return interaction.reply({
            content: "❌ You need the **Rival_Duo** role to use this command.",
            flags: MessageFlags.Ephemeral
          });
        }

        const gameId = cleanGameId(interaction.options.getString("id"));
        const heartbeatName = interaction.options.getString("heartbeat_name").trim();

        if (!gameId) {
          return interaction.reply({
            content: "❌ ID must be exactly 16 digits.",
            flags: MessageFlags.Ephemeral
          });
        }

        const pending = {
          discordId: interaction.user.id,
          name: interaction.member?.displayName || interaction.user.username,
          heartbeatName,
          gameId
        };

        await savePendingRivalDuoRegistration(interaction.user.id, pending);
        const openDuos = await findOpenRivalDuos();

        if (!openDuos.length) {
          const result = await registerRivalDuoMember(pending);
          if (result.ok) await setActiveRole(interaction.user.id, "Rival_Duo");
          return interaction.reply({ content: result.message, flags: MessageFlags.Ephemeral });
        }

        const menu = new StringSelectMenuBuilder()
          .setCustomId(`rival_duo_select_${interaction.user.id}`)
          .setPlaceholder("Select open Duo or create new")
          .addOptions([
            { label: "➕ Create new Rival Duo", value: "create_new" },
            ...openDuos.slice(0, 24).map((duo) => ({
              label: displayRivalDuoName(duo).slice(0, 100),
              value: duo.id
            }))
          ]);

        return interaction.reply({
          content: "🤝 Open Rival Duo registrations found. Select one to join or create a new Duo:",
          components: [new ActionRowBuilder().addComponents(menu)],
          flags: MessageFlags.Ephemeral
        });
      }

      if (commandName === "duo_list") {
        const hasRole =
          interaction.member?.roles?.cache?.some((r) => r.name === "Rival_Duo" || r.name === "Rival Duo") ||
          isChampion(interaction);

        if (!hasRole) {
          return interaction.reply({
            content: "❌ You need the **Rival_Duo** or **Champion** role to use this command.",
            flags: MessageFlags.Ephemeral
          });
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const message = await buildRivalDuoListMessage();
        return interaction.editReply(message);
      }

      if (commandName === "yield_reroll") {
        const hasRole = interaction.member?.roles?.cache?.some(
          (r) => r.name === "Rival_Duo" || r.name === "Rival Duo"
        );
        if (!hasRole) {
          return interaction.reply({
            content: "❌ You need the **Rival_Duo** role to use this command.",
            flags: MessageFlags.Ephemeral
          });
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const res = await toggleCedeReroll(interaction.user.id);
        return interaction.editReply(res.message);
      }

      if (commandName === "online_count") {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const lines = [];
        for (const group of Object.keys(GROUP_CONFIG)) {
          const onlineUsers = await getOnlineUsersByGroup(group);
          lines.push(`• **${getGroupLabel(group)}**: \`${onlineUsers.length}/${MAX_ONLINE_PER_GROUP}\` online`);
        }
        return interaction.editReply(`## 🟢 Online Users\n\n${lines.join("\n")}`);
      }

      if (commandName === "online") {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const activeRole = await getUserGroup(interaction);

        if (activeRole === "Rival_Duo") {
          const result = await setRivalDuoOnline(interaction.user.id);
          if (!result.ok) return interaction.editReply(result.message);

          const rows = result.duos.slice(0, 5).map((d) => buildRivalDuoGroupMenu(d, interaction.user.id));
          return interaction.editReply({
            content: `${result.message}\n\n**Both members must select the same group:**`,
            components: rows
          });
        }

        if (!activeRole) return interaction.editReply("❌ No active group selected.");

        const found = await findUserRegistration(interaction.user.id, activeRole);
        if (!found?.userData?.main_id) {
          return interaction.editReply("❌ You are not registered yet. Use `/register` or the **Register Main** button first.");
        }

        const { userData, group } = found;
        const onlineUsers = await getOnlineUsersByGroup(group);

        if (onlineUsers.length >= MAX_ONLINE_PER_GROUP) {
          return interaction.editReply(
            `❌ The **${getGroupLabel(group)}** group is full (**${MAX_ONLINE_PER_GROUP}/${MAX_ONLINE_PER_GROUP}** online).`
          );
        }

        const ok = await setOnlineStatus("online", userData.main_id, group);
        if (!ok) return interaction.editReply("❌ Could not set main account online.");

        return interaction.editReply(`🟢 Main account (\`${userData.main_id}\`) is now **ONLINE** in **${getGroupLabel(group)}**.`);
      }

      if (commandName === "online_sec") {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        if (await isActiveRivalDuo(interaction)) {
          return interaction.editReply("❌ Rival Duo does not use secondary IDs.");
        }

        const activeRole = await getUserGroup(interaction);
        if (!activeRole) return interaction.editReply("❌ No active group selected.");

        const found = await findUserRegistration(interaction.user.id, activeRole);
        if (!found?.userData?.sec_id) {
          return interaction.editReply("❌ You do not have a Secondary ID registered.");
        }

        const { userData, group } = found;
        const ok = await setOnlineStatus("online", userData.sec_id, group);
        if (!ok) return interaction.editReply("❌ Could not set secondary account online.");

        return interaction.editReply(`🟢 Secondary account (\`${userData.sec_id}\`) is now **ONLINE** in **${getGroupLabel(group)}**.`);
      }

      if (commandName === "offline") {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const activeRole = await getUserGroup(interaction);

        if (activeRole === "Rival_Duo") {
          const result = await setRivalDuoOffline(interaction.user.id, "manual_offline");
          return interaction.editReply(result.message);
        }

        if (!activeRole) return interaction.editReply("❌ No active group selected.");

        const found = await findUserRegistration(interaction.user.id, activeRole);
        if (!found) return interaction.editReply("❌ You are not registered yet.");

        const { userData, group } = found;
        if (userData.main_id) await setOnlineStatus("offline", userData.main_id, group);
        if (userData.sec_id) await setOnlineStatus("offline", userData.sec_id, group);

        return interaction.editReply(`🔴 **${userData.name}** is now **OFFLINE** in **${getGroupLabel(group)}**.`);
      }

      if (commandName === "list") {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const group = await getUserGroup(interaction);
        if (!group || !GROUP_CONFIG[group]) return interaction.editReply("❌ Select a normal group first.");

        const registeredUsers = await getUsers(group);
        if (!Object.keys(registeredUsers).length) return interaction.editReply("📭 No users registered.");

        let msg = `📋 **Registered users in ${getGroupLabel(group)}:**\n\n`;
        for (const user of Object.values(registeredUsers)) {
          msg += `👤 **${user.name}** | 📡 \`${user.heartbeatName || user.name}\` → \`${user.main_id}\`\n`;
        }
        return interaction.editReply(msg.slice(0, 1950));
      }

      if (commandName === "online_list") {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const group = await getUserGroup(interaction);
        if (!group) return interaction.editReply("❌ No active role selected.");

        if (group === "Rival_Duo") {
          const duos = await getAllRivalDuosByUser(interaction.user.id);
          if (!duos.length) return interaction.editReply("❌ You are not registered in any Rival Duo.");

          let msg = "";
          for (const duo of duos) {
            msg += `🤝 **${displayRivalDuoName(duo)}** ${duo.activeGroup ? `*(${getGroupLabel(duo.activeGroup)})*` : ""}\n`;
            for (const member of getRivalDuoMembers(duo)) {
              const online = duo.onlineUsers?.[member.discordId] ? "🟢" : "🔴";
              const active = String(member.discordId) === String(duo.activeDiscordId) ? " ⭐ **ACTIVE**" : "";
              msg += `${online} <@${member.discordId}> | \`${member.gameId}\`${active}\n`;
            }
            msg += "\n";
          }
          return interaction.editReply(msg);
        }

        const onlineUsers = await getOnlineUsersByGroup(group);
        if (!onlineUsers.length) return interaction.editReply(`⚫ No users online in **${getGroupLabel(group)}**.`);

        let msg = `🟢 **Online users in ${getGroupLabel(group)} (${onlineUsers.length}/${MAX_ONLINE_PER_GROUP}):**\n\n`;
        for (const u of onlineUsers) {
          msg += `• ${u.label} — \`${u.id}\`\n`;
        }
        return interaction.editReply(msg.slice(0, 1950));
      }

      if (commandName === "change_rol") {
        const userGroups = getMemberSelectableRoles(interaction.member);
        if (userGroups.length < 2) {
          return interaction.reply({
            content: "⚠️ You need at least 2 group roles to switch.",
            flags: MessageFlags.Ephemeral
          });
        }

        const currentRole = (await getActiveRole(interaction.user.id)) || (await getUserGroup(interaction));
        const menu = new StringSelectMenuBuilder()
          .setCustomId("role_select")
          .setPlaceholder("Select your active group")
          .addOptions(userGroups.map((g) => ({ label: getGroupLabel(g), value: g })));

        return interaction.reply({
          content: `🎭 Current active role: **${getGroupLabel(currentRole)}**\nSelect your new active group:`,
          components: [new ActionRowBuilder().addComponents(menu)],
          flags: MessageFlags.Ephemeral
        });
      }

      if (commandName === "schedule_events") {
        const mode = interaction.options.getString("mode");
        const schedules = await loadSchedules();
        const utcNow = new Date().toISOString().slice(11, 16);

        if (mode === "stop") {
          delete schedules[interaction.user.id];
          await saveSchedules(schedules);
          return interaction.reply({
            content: `🛑 Daily schedule stopped.\n🕒 Current UTC time: \`${utcNow}\``,
            flags: MessageFlags.Ephemeral
          });
        }

        const group = await getUserGroup(interaction);
        if (!group || !GROUP_CONFIG[group]) {
          return interaction.reply({ content: "❌ Select a valid reroll group first.", flags: MessageFlags.Ephemeral });
        }

        const userData = await getUser(interaction.user.id, group);
        if (!userData?.main_id) {
          return interaction.reply({ content: "❌ You must register your Main ID first.", flags: MessageFlags.Ephemeral });
        }

        const onH = interaction.options.getInteger("online_hour");
        const onM = interaction.options.getInteger("online_minute");
        const offH = interaction.options.getInteger("offline_hour");
        const offM = interaction.options.getInteger("offline_minute");

        if (onH == null || onM == null || offH == null || offM == null) {
          return interaction.reply({ content: "❌ Provide all hour and minute values.", flags: MessageFlags.Ephemeral });
        }

        if (onH < 0 || onH > 23 || offH < 0 || offH > 23 || onM < 0 || onM > 59 || offM < 0 || offM > 59) {
          return interaction.reply({ content: "❌ Invalid UTC time values.", flags: MessageFlags.Ephemeral });
        }

        schedules[interaction.user.id] = {
          group,
          main_id: userData.main_id,
          online_hour: onH,
          online_minute: onM,
          offline_hour: offH,
          offline_minute: offM,
          last_online: null,
          last_offline: null
        };

        await saveSchedules(schedules);
        return interaction.reply({
          content:
            `✅ **Daily schedule activated (${getGroupLabel(group)})**\n\n` +
            `🟢 Online: \`${String(onH).padStart(2, "0")}:${String(onM).padStart(2, "0")} UTC\`\n` +
            `🔴 Offline: \`${String(offH).padStart(2, "0")}:${String(offM).padStart(2, "0")} UTC\`\n` +
            `🕒 Current UTC: \`${utcNow}\``,
          flags: MessageFlags.Ephemeral
        });
      }

      if (commandName === "set_offline") {
        if (!isChampion(interaction)) {
          return interaction.reply({ content: "⛔ Only Champions can use this command.", flags: MessageFlags.Ephemeral });
        }

        const menu = new StringSelectMenuBuilder()
          .setCustomId("offline_group_select")
          .setPlaceholder("Select group")
          .addOptions(buildGroupOptions());

        return interaction.reply({
          content: "🛡️ Select the group to force a user offline:",
          components: [new ActionRowBuilder().addComponents(menu)],
          flags: MessageFlags.Ephemeral
        });
      }

      if (commandName === "add_vip") {
        if (!isChampion(interaction)) {
          return interaction.reply({ content: "⛔ Only Champions can use this command.", flags: MessageFlags.Ephemeral });
        }

        const id = cleanGameId(interaction.options.getString("id"));
        if (!id) {
          return interaction.reply({ content: "❌ VIP ID must be 16 digits.", flags: MessageFlags.Ephemeral });
        }

        const menu = new StringSelectMenuBuilder()
          .setCustomId(`gp_group_select:${id}`)
          .setPlaceholder("Select group to add VIP ID")
          .addOptions(buildGroupOptions());

        return interaction.reply({
          content: `👑 Select group to add VIP ID \`${id}\`:`,
          components: [new ActionRowBuilder().addComponents(menu)],
          flags: MessageFlags.Ephemeral
        });
      }
    }

    // ---------------------------------------------------------
    // 2. BOTONES DEL PANEL
    // ---------------------------------------------------------
    if (interaction.isButton()) {
      const { customId } = interaction;

      // Confirmación de Force Offline
      if (customId.startsWith("confirm_offline_")) {
        if (!isChampion(interaction)) {
          return interaction.update({ content: "⛔ Only Champions can do this.", components: [] });
        }
        const [group, id] = customId.replace("confirm_offline_", "").split("|");
        const ok = await setOnlineStatus("offline", id, group);
        return interaction.update({
          content: ok ? `🔴 ID \`${id}\` forced **OFFLINE** in **${getGroupLabel(group)}**.` : "❌ Failed to set offline.",
          components: []
        });
      }

      // Botones que abren Modal (NO hacer deferReply antes de showModal)
      if (customId === "register") {
        const modal = new ModalBuilder().setCustomId("reg_modal").setTitle("Register Main Game ID");
        modal.addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId("id").setLabel("16-Digit Main ID").setStyle(TextInputStyle.Short).setRequired(true)
          )
        );
        return interaction.showModal(modal);
      }

      if (customId === "add_sec") {
        const modal = new ModalBuilder().setCustomId("sec_modal").setTitle("Add Secondary Game ID");
        modal.addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId("id").setLabel("16-Digit Secondary ID").setStyle(TextInputStyle.Short).setRequired(true)
          )
        );
        return interaction.showModal(modal);
      }

      if (customId === "change") {
        const modal = new ModalBuilder().setCustomId("change_modal").setTitle("Change Game ID");
        modal.addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId("id").setLabel("New 16-Digit ID").setStyle(TextInputStyle.Short).setRequired(true)
          )
        );
        return interaction.showModal(modal);
      }

      if (customId === "heartbeat_name") {
        const modal = new ModalBuilder().setCustomId("heartbeat_modal").setTitle("Set Heartbeat Name");
        modal.addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId("name")
              .setLabel("Exact name shown in your heartbeat")
              .setStyle(TextInputStyle.Short)
              .setRequired(true)
          )
        );
        return interaction.showModal(modal);
      }

      if (customId === "register_duo") {
        const hasRole = interaction.member?.roles?.cache?.some(
          (r) => r.name === "Rival_Duo" || r.name === "Rival Duo"
        );
        if (!hasRole) {
          return interaction.reply({
            content: "❌ You need the **Rival_Duo** role to register here.",
            flags: MessageFlags.Ephemeral
          });
        }

        const modal = new ModalBuilder().setCustomId("rival_duo_register_modal").setTitle("Register Rival Duo");
        modal.addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId("game_id").setLabel("Your 16-digit game ID").setStyle(TextInputStyle.Short).setRequired(true)
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId("heartbeat_name").setLabel("Your exact heartbeat name").setStyle(TextInputStyle.Short).setRequired(true)
          )
        );
        return interaction.showModal(modal);
      }

      if (customId === "schedule") {
        const modal = new ModalBuilder().setCustomId("schedule_modal").setTitle("Daily Auto Schedule (UTC)");
        modal.addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId("on").setLabel("Online Time (HH:MM UTC)").setPlaceholder("08:00").setStyle(TextInputStyle.Short).setRequired(true)
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId("off").setLabel("Offline Time (HH:MM UTC)").setPlaceholder("22:00").setStyle(TextInputStyle.Short).setRequired(true)
          )
        );
        return interaction.showModal(modal);
      }

      if (customId === "gp") {
        if (!isChampion(interaction)) {
          return interaction.reply({ content: "⛔ Only Champions can use this button.", flags: MessageFlags.Ephemeral });
        }
        const modal = new ModalBuilder().setCustomId("gp_modal").setTitle("Add VIP ID");
        modal.addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId("id").setLabel("16-Digit VIP ID").setStyle(TextInputStyle.Short).setRequired(true)
          )
        );
        return interaction.showModal(modal);
      }

      // Botones directos (Con deferReply Ephemeral)
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      if (customId === "cede_reroll") {
        const hasRole = interaction.member?.roles?.cache?.some(
          (r) => r.name === "Rival_Duo" || r.name === "Rival Duo"
        );
        if (!hasRole) return interaction.editReply("❌ You need the **Rival_Duo** role to use this button.");
        const res = await toggleCedeReroll(interaction.user.id);
        return interaction.editReply(res.message);
      }

      if (customId === "duo_list") {
        const hasRole =
          interaction.member?.roles?.cache?.some((r) => r.name === "Rival_Duo" || r.name === "Rival Duo") ||
          isChampion(interaction);
        if (!hasRole) return interaction.editReply("❌ You need the **Rival_Duo** or **Champion** role.");
        const msg = await buildRivalDuoListMessage();
        return interaction.editReply(msg);
      }

      if (customId === "online") {
        const activeRole = await getUserGroup(interaction);
        if (activeRole === "Rival_Duo") {
          const result = await setRivalDuoOnline(interaction.user.id);
          if (!result.ok) return interaction.editReply(result.message);
          const rows = result.duos.slice(0, 5).map((d) => buildRivalDuoGroupMenu(d, interaction.user.id));
          return interaction.editReply({
            content: `${result.message}\n\n**Both members must select the same group:**`,
            components: rows
          });
        }

        if (!activeRole) return interaction.editReply("❌ No active group selected.");
        const found = await findUserRegistration(interaction.user.id, activeRole);
        if (!found?.userData?.main_id) return interaction.editReply("❌ Register your Main ID first.");

        const { group, userData } = found;
        const onlineIds = await getOnlineIDs(group);
        if (onlineIds.length >= MAX_ONLINE_PER_GROUP) {
          return interaction.editReply(`❌ The **${getGroupLabel(group)}** group is full (**${MAX_ONLINE_PER_GROUP}/${MAX_ONLINE_PER_GROUP}**).`);
        }

        const ok = await setOnlineStatus("online", userData.main_id, group);
        return interaction.editReply(
          ok ? `🟢 **ONLINE** in **${getGroupLabel(group)}** (\`${userData.main_id}\`).` : "❌ Could not set online."
        );
      }

      if (customId === "online_sec") {
        if (await isActiveRivalDuo(interaction)) {
          return interaction.editReply("❌ Rival Duo does not use secondary IDs.");
        }
        const activeGroup = await getUserGroup(interaction);
        const found = await findUserRegistration(interaction.user.id, activeGroup);
        if (!found?.userData?.sec_id) return interaction.editReply("❌ No secondary ID registered.");

        const ok = await setOnlineStatus("online", found.userData.sec_id, found.group);
        return interaction.editReply(
          ok ? `🟢 **SEC ONLINE** in **${getGroupLabel(found.group)}** (\`${found.userData.sec_id}\`).` : "❌ Could not set secondary online."
        );
      }

      if (customId === "offline") {
        const activeGroup = await getUserGroup(interaction);
        if (activeGroup === "Rival_Duo") {
          const result = await setRivalDuoOffline(interaction.user.id, "manual_offline");
          return interaction.editReply(result.message);
        }

        const found = await findUserRegistration(interaction.user.id, activeGroup);
        if (!found?.userData) return interaction.editReply("❌ You are not registered.");

        const { group, userData } = found;
        if (userData.main_id) await setOnlineStatus("offline", userData.main_id, group);
        if (userData.sec_id) await setOnlineStatus("offline", userData.sec_id, group);

        return interaction.editReply(`🔴 Set **OFFLINE** in **${getGroupLabel(group)}**.`);
      }

      if (customId === "list") {
        const group = await getUserGroup(interaction);
        if (!group || !GROUP_CONFIG[group]) return interaction.editReply("❌ Select a normal reroll group first.");
        const users = await getUsers(group);
        if (!Object.keys(users).length) return interaction.editReply("📭 No registered users.");

        let msg = `📋 **Users in ${getGroupLabel(group)}:**\n\n`;
        for (const u of Object.values(users)) {
          msg += `👤 **${u.name}** | 📡 \`${u.heartbeatName || u.name}\` → \`${u.main_id}\`\n`;
        }
        return interaction.editReply(msg.slice(0, 1950));
      }

      if (customId === "online_list") {
        const group = await getUserGroup(interaction);
        if (!group) return interaction.editReply("❌ No group selected.");

        if (group === "Rival_Duo") {
          const duos = await getAllRivalDuosByUser(interaction.user.id);
          if (!duos.length) return interaction.editReply("❌ You are not in any Rival Duo.");
          let msg = "";
          for (const duo of duos) {
            msg += `🤝 **${displayRivalDuoName(duo)}**\n`;
            for (const m of getRivalDuoMembers(duo)) {
              const icon = duo.onlineUsers?.[m.discordId] ? "🟢" : "🔴";
              const active = String(m.discordId) === String(duo.activeDiscordId) ? " ⭐ **ACTIVE**" : "";
              msg += `${icon} <@${m.discordId}> | \`${m.gameId}\`${active}\n`;
            }
            msg += "\n";
          }
          return interaction.editReply(msg);
        }

        const onlineUsers = await getOnlineUsersByGroup(group);
        if (!onlineUsers.length) return interaction.editReply(`⚫ No users online in **${getGroupLabel(group)}**.`);

        let msg = `🟢 **Online in ${getGroupLabel(group)} (${onlineUsers.length}/${MAX_ONLINE_PER_GROUP}):**\n\n`;
        for (const u of onlineUsers) {
          msg += `• ${u.label} — \`${u.id}\`\n`;
        }
        return interaction.editReply(msg.slice(0, 1950));
      }

      if (customId === "change_role") {
        const memberGroups = getMemberSelectableRoles(interaction.member);
        if (memberGroups.length < 2) {
          return interaction.editReply("❌ You need at least 2 group roles to switch.");
        }

        const currentRole = (await getActiveRole(interaction.user.id)) || (await getUserGroup(interaction));
        const menu = new StringSelectMenuBuilder()
          .setCustomId("role_select")
          .setPlaceholder("Select your active role")
          .addOptions(memberGroups.map((g) => ({ label: getGroupLabel(g), value: g })));

        return interaction.editReply({
          content: `🎭 Current active role: **${getGroupLabel(currentRole)}**\nSelect your new active role:`,
          components: [new ActionRowBuilder().addComponents(menu)]
        });
      }

      if (customId === "set_offline") {
        if (!isChampion(interaction)) {
          return interaction.editReply("⛔ Only Champions can use this button.");
        }
        const menu = new StringSelectMenuBuilder()
          .setCustomId("offline_group_select")
          .setPlaceholder("Select group")
          .addOptions(buildGroupOptions());

        return interaction.editReply({
          content: "🛡️ Select the group where you want to force a user offline:",
          components: [new ActionRowBuilder().addComponents(menu)]
        });
      }
    }

    // ---------------------------------------------------------
    // 3. MODALES (FORMULARIOS EMERGENTES)
    // ---------------------------------------------------------
    if (interaction.isModalSubmit()) {
      const { customId } = interaction;

      if (customId === "reg_modal") {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const msg = await handleRegisterMain(interaction, interaction.fields.getTextInputValue("id"));
        return interaction.editReply(msg);
      }

      if (customId === "sec_modal") {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const msg = await handleAddSecondary(interaction, interaction.fields.getTextInputValue("id"));
        return interaction.editReply(msg);
      }

      if (customId === "change_modal") {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const msg = await handleChangeMainId(interaction, interaction.fields.getTextInputValue("id"));
        return interaction.editReply(msg);
      }

      if (customId === "heartbeat_modal") {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const msg = await handleUpdateHeartbeatName(interaction, interaction.fields.getTextInputValue("name"));
        return interaction.editReply(msg);
      }

      if (customId === "rival_duo_register_modal") {
        const gameId = cleanGameId(interaction.fields.getTextInputValue("game_id"));
        const heartbeatName = interaction.fields.getTextInputValue("heartbeat_name").trim();

        if (!gameId) {
          return interaction.reply({ content: "❌ The ID must be exactly 16 digits.", flags: MessageFlags.Ephemeral });
        }

        const pending = {
          discordId: interaction.user.id,
          name: interaction.member?.displayName || interaction.user.username,
          heartbeatName,
          gameId
        };

        await savePendingRivalDuoRegistration(interaction.user.id, pending);
        const openDuos = await findOpenRivalDuos();

        if (!openDuos.length) {
          const result = await registerRivalDuoMember(pending);
          if (result.ok) await setActiveRole(interaction.user.id, "Rival_Duo");
          return interaction.reply({ content: result.message, flags: MessageFlags.Ephemeral });
        }

        const menu = new StringSelectMenuBuilder()
          .setCustomId(`rival_duo_select_${interaction.user.id}`)
          .setPlaceholder("Select open Duo or create new")
          .addOptions([
            { label: "➕ Create new Rival Duo", value: "create_new" },
            ...openDuos.slice(0, 24).map((duo) => ({
              label: displayRivalDuoName(duo).slice(0, 100),
              value: duo.id
            }))
          ]);

        return interaction.reply({
          content: "🤝 Open Rival Duo registrations found. Select one to join or create a new Duo:",
          components: [new ActionRowBuilder().addComponents(menu)],
          flags: MessageFlags.Ephemeral
        });
      }

      if (customId === "schedule_modal") {
        const onRaw = interaction.fields.getTextInputValue("on").trim();
        const offRaw = interaction.fields.getTextInputValue("off").trim();

        if (!/^\d{1,2}:\d{2}$/.test(onRaw) || !/^\d{1,2}:\d{2}$/.test(offRaw)) {
          return interaction.reply({ content: "❌ Use `HH:MM` format (e.g. `08:30`).", flags: MessageFlags.Ephemeral });
        }

        const [onHour, onMinute] = onRaw.split(":").map(Number);
        const [offHour, offMinute] = offRaw.split(":").map(Number);

        if (
          onHour < 0 || onHour > 23 || offHour < 0 || offHour > 23 ||
          onMinute < 0 || onMinute > 59 || offMinute < 0 || offMinute > 59
        ) {
          return interaction.reply({ content: "❌ Invalid UTC time.", flags: MessageFlags.Ephemeral });
        }

        const group = await getUserGroup(interaction);
        if (!group || !GROUP_CONFIG[group]) {
          return interaction.reply({ content: "❌ Select a valid reroll group first.", flags: MessageFlags.Ephemeral });
        }

        const userData = await getUser(interaction.user.id, group);
        if (!userData?.main_id) {
          return interaction.reply({ content: "❌ Register your Main ID first.", flags: MessageFlags.Ephemeral });
        }

        const schedules = await loadSchedules();
        schedules[interaction.user.id] = {
          group,
          main_id: userData.main_id,
          online_hour: onHour,
          online_minute: onMinute,
          offline_hour: offHour,
          offline_minute: offMinute,
          last_online: null,
          last_offline: null
        };

        await saveSchedules(schedules);
        return interaction.reply({
          content:
            `✅ **Schedule saved (${getGroupLabel(group)})**\n` +
            `🟢 Online: \`${String(onHour).padStart(2, "0")}:${String(onMinute).padStart(2, "0")} UTC\`\n` +
            `🔴 Offline: \`${String(offHour).padStart(2, "0")}:${String(offMinute).padStart(2, "0")} UTC\``,
          flags: MessageFlags.Ephemeral
        });
      }

      if (customId === "gp_modal") {
        if (!isChampion(interaction)) {
          return interaction.reply({ content: "⛔ Only Champions can use this.", flags: MessageFlags.Ephemeral });
        }

        const id = cleanGameId(interaction.fields.getTextInputValue("id"));
        if (!id) {
          return interaction.reply({ content: "❌ ID must be 16 digits.", flags: MessageFlags.Ephemeral });
        }

        const menu = new StringSelectMenuBuilder()
          .setCustomId(`gp_group_select:${id}`)
          .setPlaceholder("Select group")
          .addOptions(buildGroupOptions());

        return interaction.reply({
          content: `👑 Select the group where you want to add VIP ID \`${id}\`:`,
          components: [new ActionRowBuilder().addComponents(menu)],
          flags: MessageFlags.Ephemeral
        });
      }
    }

    // ---------------------------------------------------------
    // 4. SELECT MENUS
    // ---------------------------------------------------------
    if (interaction.isStringSelectMenu()) {
      const { customId } = interaction;

      if (customId === "role_select" || customId === "select_active_role") {
        const selected = interaction.values[0];
        await setActiveRole(interaction.user.id, selected);
        return interaction.update({
          content: `✅ Active role set to **${getGroupLabel(selected)}**.`,
          components: []
        });
      }

      if (customId.startsWith("rival_duo_select_")) {
        const targetUserId = customId.replace("rival_duo_select_", "");
        if (interaction.user.id !== targetUserId) {
          return interaction.reply({ content: "❌ This menu is not for you.", flags: MessageFlags.Ephemeral });
        }

        const pending = await loadPendingRivalDuoRegistration(interaction.user.id);
        if (!pending) {
          return interaction.update({ content: "❌ Registration expired. Try again.", components: [] });
        }

        const selected = interaction.values[0];
        const result = await registerRivalDuoMember({
          ...pending,
          duoId: selected === "create_new" ? null : selected
        });

        if (result.ok) await setActiveRole(interaction.user.id, "Rival_Duo");
        await clearPendingRivalDuoRegistration(interaction.user.id);

        return interaction.update({ content: result.message, components: [] });
      }

      if (customId.startsWith("rival_duo_group_select_")) {
        const prefix = "rival_duo_group_select_";
        const payload = customId.slice(prefix.length);
        const lastSep = payload.lastIndexOf("_");
        const duoId = payload.slice(0, lastSep);
        const discordId = payload.slice(lastSep + 1);

        if (String(interaction.user.id) !== String(discordId)) {
          return interaction.reply({ content: "❌ This menu is not for you.", flags: MessageFlags.Ephemeral });
        }

        const selectedGroup = interaction.values[0];
        const result = await selectRivalDuoGroup(discordId, selectedGroup, duoId);

        if (result.mismatch || result.full) {
          const members = getRivalDuoMembers(result.duo);
          for (const m of members) {
            try {
              const u = await client.users.fetch(m.discordId);
              await u.send(result.message);
            } catch {}
          }
        }

        return interaction.update({ content: result.message, components: [] });
      }

      if (customId.startsWith("gp_group_select:") || customId.startsWith("select_gp_group_")) {
        if (!isChampion(interaction)) {
          return interaction.update({ content: "⛔ Only Champions can do this.", components: [] });
        }
        const id = customId.includes(":")
          ? customId.split(":")[1]
          : customId.replace("select_gp_group_", "");
        const group = interaction.values[0];

        await addVipID(id, group);
        return interaction.update({
          content: `✅ VIP ID \`${id}\` added to **${getGroupLabel(group)}**.`,
          components: []
        });
      }

      if (customId === "offline_group_select" || customId === "select_offline_group") {
        if (!isChampion(interaction)) {
          return interaction.update({ content: "⛔ Only Champions can do this.", components: [] });
        }

        const group = interaction.values[0];
        const onlineUsers = await getOnlineUsersByGroup(group);

        if (!onlineUsers.length) {
          return interaction.update({
            content: `⚫ No active users in **${getGroupLabel(group)}**.`,
            components: []
          });
        }

        const options = onlineUsers.slice(0, 25).map((u) => ({
          label: u.label.slice(0, 100),
          description: u.id,
          value: `${group}|${u.id}`
        }));

        const menu = new StringSelectMenuBuilder()
          .setCustomId("forced_offline_user_select")
          .setPlaceholder("Select online user to force offline")
          .addOptions(options);

        return interaction.update({
          content: `🛡️ Select active user from **${getGroupLabel(group)}**:`,
          components: [new ActionRowBuilder().addComponents(menu)]
        });
      }

      if (customId === "forced_offline_user_select" || customId === "select_offline_user") {
        if (!isChampion(interaction)) {
          return interaction.update({ content: "⛔ Only Champions can do this.", components: [] });
        }

        const [group, id] = interaction.values[0].split("|");
        const confirm = new ButtonBuilder()
          .setCustomId(`confirm_offline_${group}|${id}`)
          .setLabel(`Confirm Force Offline (${id})`)
          .setStyle(ButtonStyle.Danger);

        return interaction.update({
          content: `⚠️ Confirm forcing ID \`${id}\` **OFFLINE** in **${getGroupLabel(group)}**:`,
          components: [new ActionRowBuilder().addComponents(confirm)]
        });
      }
    }
  } catch (err) {
    console.error("❌ Interaction error:", err);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: "❌ Internal error.", flags: MessageFlags.Ephemeral }).catch(() => {});
    } else {
      await interaction.editReply({ content: "❌ Internal error." }).catch(() => {});
    }
  }
});

// ================= DETECTOR DE VIP EN CANALES DE GP =================

client.on("messageCreate", async (message) => {
  if (message.author.bot && !message.webhookId) return;

  const group = CHANNEL_GROUP_MAP[message.channel.id];
  if (!group) return;

  const text = message.content || "";
  const match = text.match(/\((\d{16})\)/);
  if (!match) return;

  const id = match[1];
  console.log(`🔥 GP detectado en ${group}: ${id}`);
  await addVipID(id, group);
});

client.on("error", (err) => console.error("Discord client error:", err));
process.on("unhandledRejection", (err) => console.error("Unhandled rejection:", err));
process.on("uncaughtException", (err) => console.error("Uncaught exception:", err));

client.login(TOKEN);