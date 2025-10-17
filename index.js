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
import { DateTime, Interval } from "luxon";

/**
 * 설정
 */
const TZ = "Asia/Seoul"; // 한국 시간
const DAY = { OFF: "휴일", DAY: "주간", NIGHT: "야간" };

// 최초 기준(가정): 봇이 시작된 주의 월요일 00:00을 anchor로 둠
const nowKST = DateTime.now().setZone(TZ);
const thisMonday = nowKST.startOf("week").plus({ days: 1 }); // ISO week: 월요일 = week start +1
// 조승헌 8일 사이클(주/주/휴/휴/야/야/휴/휴)에서 Day1=주간으로 가정
let anchorJSH = thisMonday.startOf("day"); // /set_anchor_jsh로 변경 가능
// 지민재: 이번 주가 주간. 해당 주의 월요일을 “주간 주” anchor로 가정
let anchorJMJ = thisMonday.startOf("day"); // /set_anchor_jmj로 변경 가능

/**
 * 유틸 함수
 */
const fmtHM = (dt) => dt.setZone(TZ).toFormat("HH:mm");
const fmtYMD = (dt) => dt.setZone(TZ).toFormat("yyyy-LL-dd (ccc)");

function between(dt, start, end) {
  // dt가 [start, end) 구간에 포함되는지 (모두 TZ로 맞춰 사용)
  return Interval.fromDateTimes(start, end).contains(dt);
}

function isSecondFriday(dateKST) {
  // dateKST: Day 단위(DateTime, KST)
  const firstOfMonth = dateKST.startOf("month");
  // 첫 금요일 찾기
  let firstFriday = firstOfMonth;
  while (firstFriday.weekday !== 5) {
    // 1=Mon ... 5=Fri
    firstFriday = firstFriday.plus({ days: 1 });
  }
  const secondFriday = firstFriday.plus({ days: 7 });
  return dateKST.hasSame(secondFriday, "day");
}

/**
 * 각 사람의 "해당 시각 근무 여부" 계산기
 * return: { working: boolean, label: '주간'|'야간'|'휴일', start?: DateTime, end?: DateTime }
 */

// 1) 조승헌: 8일 반복 [주,주,휴,휴,야,야,휴,휴], 주간 07-19, 야간 19-07(+1)
function stateJSH(dt) {
  const dayIndex =
    Math.floor(dt.startOf("day").diff(anchorJSH, "days").days) % 8;
  const pat = [
    DAY.DAY,
    DAY.DAY,
    DAY.OFF,
    DAY.OFF,
    DAY.NIGHT,
    DAY.NIGHT,
    DAY.OFF,
    DAY.OFF,
  ];
  const todayLabel = pat[(dayIndex + 8) % 8];

  // 오늘 배정이 주간/야간인지 확인
  const todayStartDay = dt.startOf("day");

  // 주간(07~19)
  if (todayLabel === DAY.DAY) {
    const s = todayStartDay.plus({ hours: 7 });
    const e = todayStartDay.plus({ hours: 19 });
    if (between(dt, s, e))
      return { working: true, label: DAY.DAY, start: s, end: e };
    return { working: false, label: DAY.DAY };
  }

  // 야간(오늘 19~내일 07)
  if (todayLabel === DAY.NIGHT) {
    const s = todayStartDay.plus({ hours: 19 });
    const e = todayStartDay.plus({ days: 1, hours: 7 });
    if (between(dt, s, e))
      return { working: true, label: DAY.NIGHT, start: s, end: e };
    // 자정~07시는 "전날의 야간"이 걸릴 수 있으니 전날 검사
    const yStartDay = todayStartDay.minus({ days: 1 });
    const sPrev = yStartDay.plus({ hours: 19 });
    const ePrev = yStartDay.plus({ days: 1, hours: 7 });
    if (between(dt, sPrev, ePrev))
      return { working: true, label: DAY.NIGHT, start: sPrev, end: ePrev };
    return { working: false, label: DAY.NIGHT };
  }

  // 휴일이더라도 직전일 야간이 새벽에 걸릴 수 있음 → 전날 패턴이 야간인지 확인
  const yStartDay = todayStartDay.minus({ days: 1 });
  const yIndex = Math.floor(yStartDay.diff(anchorJSH, "days").days) % 8;
  const yLabel = pat[(yIndex + 8) % 8];
  if (yLabel === DAY.NIGHT) {
    const sPrev = yStartDay.plus({ hours: 19 });
    const ePrev = yStartDay.plus({ days: 1, hours: 7 });
    if (between(dt, sPrev, ePrev))
      return { working: true, label: DAY.NIGHT, start: sPrev, end: ePrev };
  }

  return { working: false, label: DAY.OFF };
}

// 2) 정윤근: 평일 13~22, 매달 둘째주 금요일은 13~18
function stateJYG(dt) {
  const d = dt.setZone(TZ);
  const isWeekday = d.weekday >= 1 && d.weekday <= 5;
  if (!isWeekday) return { working: false, label: DAY.OFF };

  const start = d.startOf("day").plus({ hours: 13 });
  const is2ndFri = d.weekday === 5 && isSecondFriday(d.startOf("day"));
  const end = d.startOf("day").plus({ hours: is2ndFri ? 18 : 22 });

  if (between(d, start, end))
    return { working: true, label: DAY.DAY, start, end };
  return { working: false, label: DAY.DAY, start, end };
}

// 3) 지민재: 주/야 주 단위로 번갈아. 이번 주가 주간.
//   - 주간: 월~토 07~16
//   - 야간: 월~금, 일 15~23
function isJMJDayWeek(dayStart) {
  // anchorJMJ가 "주간 주"의 월요일 00:00
  const weekDiff = Math.floor(
    dayStart
      .startOf("week")
      .plus({ days: 1 })
      .diff(anchorJMJ.startOf("week").plus({ days: 1 }), "weeks").weeks
  );
  // 0,2,4... => 주간 주 / 1,3,5... => 야간 주
  return weekDiff % 2 === 0;
}
function stateJMJ(dt) {
  const d = dt.setZone(TZ);
  const dayStart = d.startOf("day");
  const dayOfWeek = d.weekday; // 1=월 ... 7=일
  const dayWeek = isJMJDayWeek(dayStart);

  if (dayWeek) {
    // 주간: 월~토 07~16
    const isWorkingDay = dayOfWeek >= 1 && dayOfWeek <= 6;
    if (!isWorkingDay) return { working: false, label: DAY.OFF };
    const s = dayStart.plus({ hours: 7 });
    const e = dayStart.plus({ hours: 16 });
    if (between(d, s, e))
      return { working: true, label: DAY.DAY, start: s, end: e };
    return { working: false, label: DAY.DAY, start: s, end: e };
  } else {
    // 야간: 월~금, 일 15~23 (토 휴무)
    const isWorkingDay = (dayOfWeek >= 1 && dayOfWeek <= 5) || dayOfWeek === 7;
    if (!isWorkingDay) return { working: false, label: DAY.OFF };
    const s = dayStart.plus({ hours: 15 });
    const e = dayStart.plus({ hours: 23 });
    if (between(d, s, e))
      return { working: true, label: DAY.NIGHT, start: s, end: e };
    return { working: false, label: DAY.NIGHT, start: s, end: e };
  }
}

/**
 * 출력 헬퍼
 */
function renderStateLine(name, st) {
  if (st.working) {
    return `- ${name}: ${st.label} 근무중 (${fmtHM(st.start)} ~ ${fmtHM(
      st.end
    )})`;
  }
  if (st.label === DAY.OFF) return `- ${name}: 휴일`;
  // 근무는 아니지만 오늘의 근무창 존재(정해진 시간대 밖)
  if (st.start && st.end)
    return `- ${name}: 오늘 ${st.label} (${fmtHM(st.start)} ~ ${fmtHM(
      st.end
    )})`;
  return `- ${name}: ${st.label}`;
}

/**
 * Discord 클라이언트 & 커맨드
 */
const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

const commands = [
  new SlashCommandBuilder()
    .setName("지금")
    .setDescription("지금(한국시간) 같이 게임 가능한 친구 확인"),
  new SlashCommandBuilder()
    .setName("오늘")
    .setDescription("오늘(한국시간) 개인별 근무 시간 요약"),
  new SlashCommandBuilder()
    .setName("이번주")
    .setDescription("이번 주(월~일) 근무표 요약"),
  new SlashCommandBuilder()
    .setName("조승헌설정")
    .setDescription("조승헌 8일 사이클 기준일 설정 (yyyy-mm-dd, Day1=주간)")
    .addStringOption((o) =>
      o.setName("date").setDescription("예: 2025-10-13").setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName("지민재설정")
    .setDescription(
      "지민재 주간-야간 기준 주의 시작일(월요일) 설정 (yyyy-mm-dd)"
    )
    .addStringOption((o) =>
      o.setName("date").setDescription("예: 2025-10-13").setRequired(true)
    ),
].map((c) => c.toJSON());

const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);

async function registerCommands() {
  try {
    await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), {
      body: commands,
    });
    console.log("✅ Slash commands registered");
  } catch (e) {
    console.error("Slash command register error:", e);
  }
}

client.once(Events.ClientReady, (c) => {
  console.log(`🤖 Logged in as ${c.user.tag}`);
});

/**
 * 커맨드 핸들러
 */
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const now = DateTime.now().setZone(TZ);

  if (interaction.commandName === "now") {
    const s1 = stateJSH(now);
    const s2 = stateJYG(now);
    const s3 = stateJMJ(now);

    const lines = [
      `🕒 기준 시각: ${fmtYMD(now)} ${fmtHM(now)}`,
      "",
      renderStateLine("조승헌", s1),
      renderStateLine("정윤근", s2),
      renderStateLine("지민재", s3),
      "",
      `🎮 지금 같이 가능한 인원: ${
        [
          ["조승헌", s1],
          ["정윤근", s2],
          ["지민재", s3],
        ]
          .filter(([, st]) => !st.working)
          .map(([n]) => n)
          .join(", ") || "없음"
      }`,
    ].join("\n");

    await interaction.reply(lines);
  }

  if (interaction.commandName === "today") {
    const dayStart = now.startOf("day");
    const s1 = stateJSH(now);
    const s2 = stateJYG(now);
    const s3 = stateJMJ(now);

    const lines = [
      `📅 오늘: ${fmtYMD(now)}`,
      "",
      renderStateLine(
        "조승헌",
        s1.start || s1.end ? s1 : stateJSH(dayStart.plus({ hours: 12 }))
      ),
      renderStateLine(
        "정윤근",
        s2.start || s2.end ? s2 : stateJYG(dayStart.plus({ hours: 12 }))
      ),
      renderStateLine(
        "지민재",
        s3.start || s3.end ? s3 : stateJMJ(dayStart.plus({ hours: 12 }))
      ),
    ].join("\n");

    await interaction.reply(lines);
  }

  if (interaction.commandName === "week") {
    const monday = now.startOf("week").plus({ days: 1 }).startOf("day"); // 이번 주 월요일
    const days = Array.from({ length: 7 }, (_, i) => monday.plus({ days: i }));

    const lines = ["🗓 이번 주 근무표 (한국시간)\n"];
    for (const d of days) {
      const mid = d.plus({ hours: 12 }); // 당일 대략적인 상태 확인용
      const jsh = stateJSH(mid);
      const jyg = stateJYG(mid);
      const jmj = stateJMJ(mid);

      const jshTxt =
        jsh.label === DAY.OFF
          ? "휴일"
          : jsh.label === DAY.DAY
          ? "주간 07:00~19:00"
          : "야간 19:00~07:00(+1)";
      const jygTxt =
        d.weekday >= 1 && d.weekday <= 5
          ? `주간 13:00~${
              isSecondFriday(d) && d.weekday === 5 ? "18:00" : "22:00"
            }`
          : "휴일";
      const jmjDay = isJMJDayWeek(d) ? "주간" : "야간";
      const jmjTxt = isJMJDayWeek(d)
        ? d.weekday <= 6
          ? "주간 07:00~16:00"
          : "휴일"
        : [1, 2, 3, 4, 5, 7].includes(d.weekday)
        ? "야간 15:00~23:00"
        : "휴일";

      lines.push(
        `• ${fmtYMD(d)}\n` +
          `  - 조승헌: ${jshTxt}\n` +
          `  - 정윤근: ${jygTxt}\n` +
          `  - 지민재: ${jmjTxt} (${jmjDay}주)`
      );
    }

    await interaction.reply(lines.join("\n"));
  }

  if (interaction.commandName === "set_anchor_jsh") {
    const dateStr = interaction.options.getString("date", true);
    const parsed = DateTime.fromISO(dateStr, { zone: TZ }).startOf("day");
    if (!parsed.isValid) {
      await interaction.reply(
        "❌ 날짜 형식이 올바르지 않습니다. 예: 2025-10-13"
      );
      return;
    }
    anchorJSH = parsed;
    await interaction.reply(
      `✅ 조승헌 8일 사이클 기준일을 **${fmtYMD(
        anchorJSH
      )}** 로 설정했습니다. (Day1=주간)`
    );
  }

  if (interaction.commandName === "set_anchor_jmj") {
    const dateStr = interaction.options.getString("date", true);
    const parsed = DateTime.fromISO(dateStr, { zone: TZ }).startOf("day");
    if (!parsed.isValid) {
      await interaction.reply(
        "❌ 날짜 형식이 올바르지 않습니다. 예: 2025-10-13"
      );
      return;
    }
    // 월요일로 보정하진 않고, 입력하신 날짜가 속한 주의 월요일을 앵커로 사용
    anchorJMJ = parsed.startOf("week").plus({ days: 1 }).startOf("day");
    await interaction.reply(
      `✅ 지민재 주간-야간 기준 주를 **${fmtYMD(
        anchorJMJ
      )}** 시작 주(월요일)로 설정했습니다. (이 주가 "주간 주")`
    );
  }
});

/**
 * Render용 keep-alive 웹서버 (포트 열기)
 */
const app = express();
app.get("/", (_req, res) =>
  res.send("✅ Discord game-check bot is running (KST).")
);
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🌐 Keep-alive server on ${PORT}`));

/**
 * 시작
 */
await registerCommands();
client.login(process.env.DISCORD_TOKEN);
