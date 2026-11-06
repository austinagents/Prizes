const db = require('../db/database');
const crypto = require('node:crypto');

function createGiveaway(data) {
  const stmt = db.prepare(`
    INSERT INTO giveaways (
      guild_id,
      channel_id,
      product_name,
      image_url,
      description,
      ends_at,
      winner_count,
      created_by,
      created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const result = stmt.run(
    data.guildId,
    data.channelId,
    data.productName,
    data.imageUrl,
    data.description,
    data.endsAt,
    data.winnerCount,
    data.createdBy,
    Date.now()
  );

  return result.lastInsertRowid;
}

function setGiveawayMessageId(giveawayId, messageId) {
  db.prepare(`
    UPDATE giveaways
    SET message_id = ?
    WHERE id = ?
  `).run(messageId, giveawayId);
}

function getGiveaway(giveawayId) {
  return db.prepare(`
    SELECT *
    FROM giveaways
    WHERE id = ?
  `).get(giveawayId);
}

function getActiveGiveaways() {
  return db.prepare(`
    SELECT *
    FROM giveaways
    WHERE status = 'active'
  `).all();
}

function markGiveawayEnded(giveawayId) {
  db.prepare(`
    UPDATE giveaways
    SET status = 'ended'
    WHERE id = ? AND status = 'ending' AND announcement_message_id IS NOT NULL
  `).run(giveawayId);
}

function addEntry(giveawayId, userId) {
  try {
    db.prepare(`
      INSERT INTO giveaway_entries (
        giveaway_id,
        user_id,
        entered_at
      )
      VALUES (?, ?, ?)
    `).run(giveawayId, userId, Date.now());

    return true;
  } catch (error) {
    if (
      error.code === 'SQLITE_CONSTRAINT_PRIMARYKEY' ||
      error.code === 'SQLITE_CONSTRAINT'
    ) {
      return false;
    }

    throw error;
  }
}

function getEntries(giveawayId) {
  return db.prepare(`
    SELECT user_id
    FROM giveaway_entries
    WHERE giveaway_id = ?
    ORDER BY entered_at ASC
  `).all(giveawayId);
}

function getEntryCount(giveawayId) {
  const row = db.prepare(`
    SELECT COUNT(*) AS count
    FROM giveaway_entries
    WHERE giveaway_id = ?
  `).get(giveawayId);

  return row.count;
}


function getPendingGiveaways() {
  return db.prepare(`
    SELECT * FROM giveaways
    WHERE status = 'ending'
       OR (status = 'active' AND CAST(ends_at AS INTEGER) <= ?)
    ORDER BY ends_at ASC
  `).all(Date.now());
}

// The winners are chosen and persisted once, atomically, BEFORE any Discord call.
// A retry or restart cannot reroll them.
const prepareGiveawayEnding = db.transaction((giveawayId) => {
  const giveaway = getGiveaway(giveawayId);
  if (!giveaway || giveaway.status === 'ended') return giveaway;
  if (giveaway.status !== 'active') return giveaway;

  const pool = [...getEntries(giveawayId)];
  const count = Math.min(Number(giveaway.winner_count), pool.length);
  const insert = db.prepare(`
    INSERT INTO giveaway_winners (giveaway_id, user_id, position)
    VALUES (?, ?, ?)
  `);

  for (let i = 0; i < count; i++) {
    const index = crypto.randomInt(pool.length);
    const [winner] = pool.splice(index, 1);
    insert.run(giveawayId, winner.user_id, i + 1);
  }

  db.prepare("UPDATE giveaways SET status = 'ending' WHERE id = ? AND status = 'active'")
    .run(giveawayId);

  return getGiveaway(giveawayId);
});

function getSavedWinners(giveawayId) {
  return db.prepare(`
    SELECT user_id FROM giveaway_winners
    WHERE giveaway_id = ?
    ORDER BY position ASC
  `).all(giveawayId);
}

function setAnnouncementMessageId(giveawayId, messageId) {
  db.prepare(`
    UPDATE giveaways
    SET announcement_message_id = ?
    WHERE id = ? AND status = 'ending'
  `).run(messageId, giveawayId);
}

module.exports = {
  createGiveaway,
  setGiveawayMessageId,
  getGiveaway,
  getActiveGiveaways,
  getPendingGiveaways,
  prepareGiveawayEnding,
  getSavedWinners,
  setAnnouncementMessageId,
  markGiveawayEnded,
  addEntry,
  getEntries,
  getEntryCount,
};
