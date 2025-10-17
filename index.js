import "dotenv/config";
import express from "express";
import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  Events,
} from "discord.js";

// 🔹 Discord 클라이언트 생성
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// 🔹 Slash Command 정의
const commands = [
  new SlashCommandBuilder()
    .setName("ping")
    .setDescription("Replies with pong!"),
].map((cmd) => cmd.toJSON());

// 🔹 REST API로 Discord에 명령 등록
const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);

async function registerCommands() {
  try {
    await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), {
      body: commands,
    });
    console.log("✅ Slash commands registered.");
  } catch (e) {
    console.error(e);
  }
}

// 🔹 봇이 준비되면 로그 표시
client.once(Events.ClientReady, (c) => {
  console.log(`🤖 Logged in as ${c.user.tag}`);
});

// 🔹 /ping 명령 응답
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName === "ping") {
    await interaction.reply("pong!");
  }
});

// 🔹 Express 웹 서버 (Render용)
const app = express();
app.get("/", (req, res) => res.send("✅ Discord bot is alive on Render!"));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🌐 Server running on port ${PORT}`));

// 🔹 명령 등록 및 로그인
registerCommands();
client.login(process.env.DISCORD_TOKEN);
