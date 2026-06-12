const MODULE_ID = "cpr-attack-damage-multiplier";

const pendingMultipliers = new Map();

function makeKey(actorId, itemId) {
  return `${actorId}.${itemId}`;
}

// Table d'exemple.
// Change ces seuils comme tu veux.
function multiplierFromAttackTotal(total) {
  if (total >= 18) return 4;
  if (total >= 15) return 3;
  if (total >= 12) return 2;
  return 1;
}

function roundDamage(value) {
  return Math.ceil(value);
}

function getAttackTotalFromChat(content) {
  const div = document.createElement("div");
  div.innerHTML = content;

  const totalElement = div.querySelector(
    "span.clickable[data-action='toggleVisibility']"
  );

  if (!totalElement) return null;

  const total = Number.parseInt(totalElement.textContent.trim(), 10);
  return Number.isFinite(total) ? total : null;
}

function getRollDamageDataset(content) {
  const div = document.createElement("div");
  div.innerHTML = content;

  const damageButton = div.querySelector("[data-action='rollDamage']");
  return damageButton?.dataset ?? null;
}

// 1. Quand une carte d'attaque apparaît dans le chat,
// on lit son total et on prépare le multiplicateur pour l'arme concernée.
Hooks.on("createChatMessage", async (message) => {
  if (game.system.id !== "cyberpunk-red-core") return;
  if (!message.content) return;

  const data = getRollDamageDataset(message.content);
  if (!data?.actorId || !data?.itemId) return;

  const attackTotal = getAttackTotalFromChat(message.content);
  if (attackTotal === null) return;

  const multiplier = multiplierFromAttackTotal(attackTotal);
  const key = makeKey(data.actorId, data.itemId);

  pendingMultipliers.set(key, {
    multiplier,
    attackTotal,
    createdAt: Date.now()
  });

  if (multiplier > 1) {
    // createChatMessage se déclenche sur tous les clients connectés :
    // seul l'auteur du jet d'attaque crée le message de confirmation,
    // sinon chaque client en crée une copie.
    const authorId = message.author?.id ?? message.user?.id;
    if (game.user.id !== authorId) return;

    ChatMessage.create({
      speaker: message.speaker,
      content: `
        <div class="cpr-block" style="padding: 8px;">
          <strong>Multiplicateur préparé :</strong>
          jet d'attaque ${attackTotal} → dégâts ×${multiplier}
        </div>
      `
    });
  }
});

// 2. On intercepte la création du CPRDamageRoll.
// Cyberpunk RED Core passe par createRoll("damage", ...), puis crée un CPRDamageRoll.
// On modifie seulement _computeBase() sur ce jet précis.
Hooks.once("ready", () => {
  if (game.system.id !== "cyberpunk-red-core") return;

  const ItemClass = CONFIG.Item.documentClass;

  if (ItemClass.prototype._akiDamageMultiplierPatched) return;
  ItemClass.prototype._akiDamageMultiplierPatched = true;

  const originalCreateRoll = ItemClass.prototype.createRoll;

  ItemClass.prototype.createRoll = function patchedCreateRoll(
    type,
    actor,
    extraData = []
  ) {
    const cprRoll = originalCreateRoll.call(this, type, actor, extraData);

    if (type !== "damage") return cprRoll;
    if (!cprRoll) return cprRoll;

    const actorId = actor?.id ?? this.actor?.id;
    const itemId = this.id;

    if (!actorId || !itemId) return cprRoll;

    const key = makeKey(actorId, itemId);
    const pending = pendingMultipliers.get(key);

    if (!pending) return cprRoll;

    // Sécurité : le multiplicateur expire après 2 minutes.
    if (Date.now() - pending.createdAt > 120000) {
      pendingMultipliers.delete(key);
      return cprRoll;
    }

    pendingMultipliers.delete(key);

    const multiplier = pending.multiplier;

    if (multiplier <= 1) return cprRoll;

    const originalComputeBase = cprRoll._computeBase.bind(cprRoll);

    cprRoll._computeBase = function patchedComputeBase() {
      const baseDamage = originalComputeBase();
      const multipliedDamage = roundDamage(baseDamage * multiplier);

      return multipliedDamage;
    };

    cprRoll.rollTitle = `${cprRoll.rollTitle} ×${multiplier}`;

    return cprRoll;
  };

  console.log(`${MODULE_ID} | ready`);
});
