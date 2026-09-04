require('dotenv').config();

const crypto = require('crypto');

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
  getActiveGiveaways,
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

function pickRandomWinners(entries, winnerCount) {
  const pool = [...entries];
  const winners = [];

  const count = Math.min(winnerCount, pool.length);

  for (let i = 0; i < count; i++) {
    const index = crypto.randomInt(pool.length);
    winners.push(pool[index]);
    pool.splice(index, 1);
  }

  return winners;
}

async function endGiveaway(giveaway) {
  if (endingGiveaways.has(giveaway.id)) {
    return;
  }

  endingGiveaways.add(giveaway.id);

  try {
    const freshGiveaway = getGiveaway(giveaway.id);

    if (!freshGiveaway || freshGiveaway.status !== 'active') {
      return;
    }

    const entries = getEntries(giveaway.id);
    const winners = pickRandomWinners(
      entries,
      Number(giveaway.winner_count)
    );

    markGiveawayEnded(giveaway.id);

    const channel = await client.channels.fetch(giveaway.channel_id);

    if (!channel || !channel.isTextBased()) {
      console.error(
        `Could not fetch giveaway channel for giveaway ${giveaway.id}`
      );
      return;
    }

    if (giveaway.message_id) {
      try {
        const message = await channel.messages.fetch(giveaway.message_id);

        const disabledButton = new ButtonBuilder()
          .setCustomId(`enter_giveaway:${giveaway.id}`)
          .setLabel('Giveaway Ended')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(true);

        const row = new ActionRowBuilder().addComponents(disabledButton);

        await message.edit({
          embeds: [
            buildGiveawayEmbed(
              giveaway,
              entries.length,
              true
            ),
          ],
          components: [row],
        });
      } catch (error) {
        console.error(
          `Could not update giveaway message ${giveaway.id}:`,
          error
        );
      }
    }

    if (winners.length === 0) {
      await channel.send({
        content: `🎉 **${giveaway.product_name}** giveaway ended with no entries.`,
      });

      return;
    }

    const winnerMentions = winners
      .map((entry) => `<@${entry.user_id}>`)
      .join(' ');

    const winnerText =
      winners.length === 1
        ? `🎉 **Congrats ${winnerMentions}, you won ${giveaway.product_name}!**`
        : `🎉 **Congrats ${winnerMentions}, you won ${giveaway.product_name}!**`;

    const winnerEmbed = new EmbedBuilder()
      .setTitle('🏆 Giveaway Winner')
      .setDescription(winnerText)
      .setImage(giveaway.image_url);

    await channel.send({
      content: winnerMentions,
      embeds: [winnerEmbed],
    });
  } catch (error) {
    console.error(`Failed to end giveaway ${giveaway.id}:`, error);
  } finally {
    endingGiveaways.delete(giveaway.id);
  }
}

async function checkExpiredGiveaways() {
  try {
    const giveaways = getActiveGiveaways();
    const now = Date.now();

    for (const giveaway of giveaways) {
      if (Number(giveaway.ends_at) <= now) {
        await endGiveaway(giveaway);
      }
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
