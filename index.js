import 'dotenv/config';
import { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, Events } from 'discord.js';

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

// Register a simple slash command: /ping
const commands = [
  new SlashCommandBuilder().setName('ping').setDescription('Replies with pong!'),
].map(cmd => cmd.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

async function registerCommands() {
  try {
    // Globally register commands (may take up to an hour to appear); for instant dev feedback,
    // use Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID)
    await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });
    console.log('Slash commands registered.');
  } catch (e) {
    console.error(e);
  }
}

client.once(Events.ClientReady, c => {
  console.log(`Logged in as ${c.user.tag}`);
});

client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName === 'ping') {
    await interaction.reply('pong!');
  }
});

registerCommands();
client.login(process.env.DISCORD_TOKEN);
