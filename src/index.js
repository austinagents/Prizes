require('dotenv').config();

const {
  Client,
  GatewayIntentBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  EmbedBuilder,
  LabelBuilder,
  FileUploadBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
} = require('discord.js');

const {
  createGiveaway,
  setGiveawayMessageId,
  getGiveaway,
  getPendingGiveaways,
  prepareGiveawayEnding,
  getSavedWinners,
  setAnnouncementMessageId,
  markGiveawayEnded,
  addEntry,
  getEntries,
  getEntryCount,
} = require('./services/giveaways');

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

const pendingGiveaways = new Map();
const endingGiveaways = new Set();

const DURATION_MS = {
  '1m': 1 * 60 * 1000,
  '5m': 5 * 60 * 1000,
  '10m': 10 * 60 * 1000,
  '30m': 30 * 60 * 1000,
  '1h': 60 * 60 * 1000,
};

function buildGiveawayEmbed(giveaway, entryCount = 0, ended = false) {
  const unixEnd = Math.floor(Number(giveaway.ends_at) / 1000);

  const embed = new EmbedBuilder()
    .setTitle(`🎉 ${giveaway.product_name}`)
    .setDescription(
      ended
        ? 'This giveaway has ended.'
        : 'Click the button below to enter!'
    )
    .setImage(giveaway.image_url)
    .addFields(
      {
        name: 'Status',
        value: ended ? 'Ended' : `Ends <t:${unixEnd}:R>`,
        inline: true,
      },
      {
        name: 'Winners',
        value: String(giveaway.winner_count),
        inline: true,
      },
      {
        name: 'Entries',
        value: String(entryCount),
        inline: true,
      }
    );

  return embed;
}


function viewEntriesRow(giveawayId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`view_entries:${giveawayId}`)
      .setLabel('View Entries')
      .setStyle(ButtonStyle.Secondary)
  );
}

function buildEntriesResponse(giveaway, requestedPage = 0) {
  const entries = getEntries(giveaway.id);
  const pageSize = 25;
  const pages = Math.max(1, Math.ceil(entries.length / pageSize));
  const page = Math.max(0, Math.min(requestedPage, pages - 1));
  const onPage = entries.slice(page * pageSize, (page + 1) * pageSize);
  const lines = onPage.map((entry, offset) =>
    `${page * pageSize + offset + 1}. <@${entry.user_id}>`
  );
  const content = [
    `📋 **Entries — ${giveaway.product_name}**`,
    `**${entries.length} total** · Page ${page + 1}/${pages}`,
    '',
    lines.length ? lines.join('\\n') : 'No entries.',
  ].join('\\n');

  const components = [];
  if (pages > 1) {
    components.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`entries_page:${giveaway.id}:${page - 1}`)
        .setLabel('Previous')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page === 0),
      new ButtonBuilder()
        .setCustomId(`entries_page:${giveaway.id}:${page + 1}`)
        .setLabel('Next')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page + 1 >= pages)
    ));
  }

  return { content, components, allowedMentions: { parse: [] } };
}

function announcementMarker(giveawayId) {
  return `Prizes giveaway #${giveawayId} results`;
}

// Check for an announcement whose Discord reply was lost before SQLite recorded
// its message ID. We scan back to the giveaway's scheduled end, up to 1,000 messages.
async function findExistingAnnouncement(channel, giveaway) {
  let before;
  for (let i = 0; i < 10; i++) {
    const options = before ? { limit: 100, before } : { limit: 100 };
    const messages = await channel.messages.fetch(options);
    if (!messages.size) break;

    const existing = messages.find((message) =>
      message.author?.id === client.user.id &&
      message.embeds.some((embed) =>
        embed.footer?.text === announcementMarker(giveaway.id)
      )
    );
    if (existing) return existing;

    const oldest = messages.last();
    if (!oldest || oldest.createdTimestamp < Number(giveaway.ends_at) - 60000) break;
    before = oldest.id;
  }
  return null;
}

async function endGiveaway(giveaway) {
  if (endingGiveaways.has(giveaway.id)) return;
  endingGiveaways.add(giveaway.id);

  try {
    const fresh = getGiveaway(giveaway.id);
    if (!fresh || !['active', 'ending'].includes(fresh.status)) return;

    // Durable selection BEFORE attempting Discord I/O.
    const ending = prepareGiveawayEnding(giveaway.id);
    const entries = getEntries(giveaway.id);
    const winners = getSavedWinners(giveaway.id);
    const channel = await client.channels.fetch(ending.channel_id);

    if (!channel || !channel.isTextBased()) {
      throw new Error(`Could not fetch giveaway channel for giveaway ${giveaway.id}`);
    }

    // Publish a separate winners message, with a stable nonce and marker.
    // Saved message IDs stop routine retries from posting duplicates.
    if (!ending.announcement_message_id) {
      const winnerMentions = winners.map(({ user_id }) => `<@${user_id}>`).join(' ');
      const winnerText = winners.length
        ? `🎉 **Congrats ${winnerMentions}, you won ${ending.product_name}!**`
        : `**${ending.product_name}** ended with no entries.`;
      const embed = new EmbedBuilder()
        .setTitle(winners.length ? '🏆 Giveaway Winners' : '🎉 Giveaway Ended')
        .setDescription(winnerText)
        .setImage(ending.image_url)
        .setFooter({ text: announcementMarker(ending.id) });

      let announcement = await findExistingAnnouncement(channel, ending);
      if (!announcement) {
        announcement = await channel.send({
          content: winners.length ? winnerMentions : `🎉 ${ending.product_name} ended with no entries.`,
          embeds: [embed],
          components: [viewEntriesRow(ending.id)],
          nonce: `prize-results-${ending.id}`,
          enforceNonce: true,
        });
      }
      setAnnouncementMessageId(ending.id, announcement.id);
    }

    // Replace the original Enter Giveaway button with View Entries.
    // If this edit fails transiently, next check retries the edit without
    // reselecting winners or sending another winner announcement.
    if (ending.message_id) {
      try {
        const message = await channel.messages.fetch(ending.message_id);
        await message.edit({
          embeds: [buildGiveawayEmbed(ending, entries.length, true)],
          components: [viewEntriesRow(ending.id)],
        });
      } catch (error) {
        // The original announcement was deleted: results still have View Entries.
        if (error.code !== 10008) throw error;
        console.warn(`Original giveaway message ${ending.message_id} was deleted`);
      }
    }

    markGiveawayEnded(ending.id);
    console.log(`Giveaway ${ending.id} completed; saved winners: ${winners.length}`);
  } catch (error) {
    // Keep status='ending'; the scheduler will retry. Winners cannot change.
    console.error(`Failed to finish giveaway ${giveaway.id}; will retry:`, error);
  } finally {
    endingGiveaways.delete(giveaway.id);
  }
}

async function checkExpiredGiveaways() {
  try {
    const giveaways = getPendingGiveaways();
    for (const giveaway of giveaways) {
      await endGiveaway(giveaway);
    }
  } catch (error) {
    console.error('Failed checking expired giveaways:', error);
  }
}

async function ensureAdminLauncher() {
  const channel = await client.channels.fetch(
    process.env.GIVEAWAYS_ADMIN_CHANNEL_ID
  );

  if (!channel || !channel.isTextBased()) {
    throw new Error('Invalid GIVEAWAYS_ADMIN_CHANNEL_ID');
  }

  const messages = await channel.messages.fetch({ limit: 50 });

  const existing = messages.find(
    (message) =>
      message.author.id === client.user.id &&
      message.components.some((row) =>
        row.components.some(
          (component) => component.customId === 'create_giveaway'
        )
      )
  );

  if (existing) return;

  const button = new ButtonBuilder()
    .setCustomId('create_giveaway')
    .setLabel('Create Giveaway')
    .setStyle(ButtonStyle.Primary);

  const row = new ActionRowBuilder().addComponents(button);

  await channel.send({
    content: '**Prizes Admin**',
    components: [row],
  });
}

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);

  try {
    await ensureAdminLauncher();
    console.log('Admin launcher ready.');
  } catch (error) {
    console.error('Failed to create admin launcher:', error);
  }

  await checkExpiredGiveaways();

  setInterval(() => {
    checkExpiredGiveaways();
  }, 5000);
});

client.on('interactionCreate', async (interaction) => {
  try {
    if (
      interaction.isButton() &&
      interaction.customId === 'create_giveaway'
    ) {
      if (interaction.user.id !== process.env.ADMIN_USER_ID) {
        await interaction.reply({
          content: 'You are not authorized to use this.',
          ephemeral: true,
        });
        return;
      }

      const modal = new ModalBuilder()
        .setCustomId('giveaway_modal')
        .setTitle('Create Giveaway');

      const productNameInput = new TextInputBuilder()
        .setCustomId('product_name')
        .setStyle(TextInputStyle.Short)
        .setRequired(true);

      const productNameLabel = new LabelBuilder()
        .setLabel('Product Name')
        .setTextInputComponent(productNameInput);

      const imageUpload = new FileUploadBuilder()
        .setCustomId('product_image')
        .setMinValues(1)
        .setMaxValues(1)
        .setRequired(true);

      const imageLabel = new LabelBuilder()
        .setLabel('Product Image')
        .setDescription('Upload one image')
        .setFileUploadComponent(imageUpload);

      const durationSelect = new StringSelectMenuBuilder()
        .setCustomId('duration')
        .setPlaceholder('Select giveaway duration')
        .setRequired(true)
        .setMinValues(1)
        .setMaxValues(1)
        .addOptions(
          new StringSelectMenuOptionBuilder()
            .setLabel('1 minute')
            .setValue('1m'),
          new StringSelectMenuOptionBuilder()
            .setLabel('5 minutes')
            .setValue('5m'),
          new StringSelectMenuOptionBuilder()
            .setLabel('10 minutes')
            .setValue('10m'),
          new StringSelectMenuOptionBuilder()
            .setLabel('30 minutes')
            .setValue('30m'),
          new StringSelectMenuOptionBuilder()
            .setLabel('1 hour')
            .setValue('1h')
        );

      const durationLabel = new LabelBuilder()
        .setLabel('Giveaway Duration')
        .setStringSelectMenuComponent(durationSelect);

      const winnerCountInput = new TextInputBuilder()
        .setCustomId('winner_count')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setValue('1');

      const winnerCountLabel = new LabelBuilder()
        .setLabel('Winner Count')
        .setTextInputComponent(winnerCountInput);

      modal.addLabelComponents(
        productNameLabel,
        imageLabel,
        durationLabel,
        winnerCountLabel
      );

      await interaction.showModal(modal);
      return;
    }

    if (
      interaction.isModalSubmit() &&
      interaction.customId === 'giveaway_modal'
    ) {
      if (interaction.user.id !== process.env.ADMIN_USER_ID) {
        await interaction.reply({
          content: 'You are not authorized to use this.',
          ephemeral: true,
        });
        return;
      }

      const productName =
        interaction.fields.getTextInputValue('product_name').trim();

      const durationValues =
        interaction.fields.getStringSelectValues('duration');

      const durationKey = durationValues[0];
      const durationMs = DURATION_MS[durationKey];

      const winnerCount = Number(
        interaction.fields.getTextInputValue('winner_count')
      );

      const uploadedFiles =
        interaction.fields.getUploadedFiles('product_image', true);

      const image = uploadedFiles.first();

      if (!image) {
        await interaction.reply({
          content: 'Please upload a product image.',
          ephemeral: true,
        });
        return;
      }

      if (!image.contentType || !image.contentType.startsWith('image/')) {
        await interaction.reply({
          content: 'The uploaded file must be an image.',
          ephemeral: true,
        });
        return;
      }

      if (!durationMs) {
        await interaction.reply({
          content: 'Invalid giveaway duration.',
          ephemeral: true,
        });
        return;
      }

      if (!Number.isInteger(winnerCount) || winnerCount < 1) {
        await interaction.reply({
          content: 'Winner count must be a whole number of at least 1.',
          ephemeral: true,
        });
        return;
      }

      pendingGiveaways.set(interaction.user.id, {
        productName,
        imageUrl: image.url,
        endsAt: Date.now() + durationMs,
        winnerCount,
      });

      const select = new ChannelSelectMenuBuilder()
        .setCustomId('giveaway_channel_select')
        .setPlaceholder('Choose giveaway channel')
        .addChannelTypes(ChannelType.GuildText);

      const row = new ActionRowBuilder().addComponents(select);

      await interaction.reply({
        content: 'Choose the channel where this giveaway should be posted:',
        components: [row],
        ephemeral: true,
      });

      return;
    }

    if (
      interaction.isChannelSelectMenu() &&
      interaction.customId === 'giveaway_channel_select'
    ) {
      if (interaction.user.id !== process.env.ADMIN_USER_ID) {
        await interaction.reply({
          content: 'You are not authorized to use this.',
          ephemeral: true,
        });
        return;
      }

      const pending = pendingGiveaways.get(interaction.user.id);

      if (!pending) {
        await interaction.update({
          content: 'This giveaway setup expired. Start again.',
          components: [],
        });
        return;
      }

      const channelId = interaction.values[0];
      const targetChannel = await interaction.guild.channels.fetch(channelId);

      if (!targetChannel || !targetChannel.isTextBased()) {
        await interaction.update({
          content: 'Invalid target channel.',
          components: [],
        });
        return;
      }

      const giveawayId = createGiveaway({
        guildId: interaction.guildId,
        channelId,
        productName: pending.productName,
        imageUrl: pending.imageUrl,
        description: null,
        endsAt: pending.endsAt,
        winnerCount: pending.winnerCount,
        createdBy: interaction.user.id,
      });

      const giveaway = getGiveaway(giveawayId);

      const enterButton = new ButtonBuilder()
        .setCustomId(`enter_giveaway:${giveawayId}`)
        .setLabel('🎉 Enter Giveaway')
        .setStyle(ButtonStyle.Success);

      const row = new ActionRowBuilder().addComponents(enterButton);

      const message = await targetChannel.send({
        embeds: [buildGiveawayEmbed(giveaway, 0, false)],
        components: [row],
      });

      setGiveawayMessageId(giveawayId, message.id);

      pendingGiveaways.delete(interaction.user.id);

      await interaction.update({
        content: `Giveaway posted in ${targetChannel}.`,
        components: [],
      });

      return;
    }


    if (
      interaction.isButton() &&
      (
        interaction.customId.startsWith('view_entries:') ||
        interaction.customId.startsWith('entries_page:')
      )
    ) {
      const [action, id, pageValue] = interaction.customId.split(':');
      const giveaway = getGiveaway(Number(id));
      if (!giveaway || giveaway.status === 'active') {
        await interaction.reply({
          content: 'Entries become available after the giveaway ends.',
          ephemeral: true,
        });
        return;
      }

      const page = action === 'entries_page' ? Number(pageValue) : 0;
      const response = buildEntriesResponse(giveaway, Number.isSafeInteger(page) ? page : 0);
      if (action === 'view_entries') {
        await interaction.reply({ ...response, ephemeral: true });
      } else {
        await interaction.update(response);
      }
      return;
    }

    if (
      interaction.isButton() &&
      interaction.customId.startsWith('enter_giveaway:')
    ) {
      const giveawayId = Number(
        interaction.customId.split(':')[1]
      );

      const giveaway = getGiveaway(giveawayId);

      if (!giveaway || giveaway.status !== 'active') {
        await interaction.reply({
          content: 'This giveaway is no longer active.',
          ephemeral: true,
        });
        return;
      }

      if (Date.now() >= Number(giveaway.ends_at)) {
        await interaction.reply({
          content: 'This giveaway has ended.',
          ephemeral: true,
        });

        await endGiveaway(giveaway);
        return;
      }

      const added = addEntry(giveawayId, interaction.user.id);

      if (!added) {
        await interaction.reply({
          content: 'You are already entered.',
          ephemeral: true,
        });
        return;
      }

      const entryCount = getEntryCount(giveawayId);

      await interaction.message.edit({
        embeds: [buildGiveawayEmbed(giveaway, entryCount, false)],
      });

      await interaction.reply({
        content: '🎉 You are entered!',
        ephemeral: true,
      });

      return;
    }
  } catch (error) {
    console.error('Interaction error:', error);

    if (!interaction.replied && !interaction.deferred) {
      try {
        await interaction.reply({
          content: 'Something went wrong.',
          ephemeral: true,
        });
      } catch {}
    }
  }
});

client.login(process.env.DISCORD_TOKEN);
