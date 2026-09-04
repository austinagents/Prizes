const db = require('../db/database');

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
    WHERE id = ?
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

module.exports = {
  createGiveaway,
  setGiveawayMessageId,
  getGiveaway,
  getActiveGiveaways,
  markGiveawayEnded,
  addEntry,
  getEntries,
  getEntryCount,
};
