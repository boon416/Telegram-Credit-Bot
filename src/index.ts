// src/index.ts
interface Env {
  BOT_TOKEN: string;
  credit_db: D1Database;
  ADMIN_CHAT_ID: string; // 可以是群(-100...)或个人(正数)
}

const API = (t: string, m: string) => `https://api.telegram.org/bot${t}/${m}`;
const asJSON = (x: unknown) => (typeof x === "string" ? JSON.parse(x) : x);
const yuan = (cents: number) => (cents / 100).toFixed(2);

async function send(env: Env, chat_id: number | string, text: string, extra: any = {}) {
  await fetch(API(env.BOT_TOKEN, "sendMessage"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id, text, parse_mode: "HTML", ...extra }),
  });
}
async function sendPhoto(env: Env, chat_id: number | string, file_id: string, caption: string, extra: any = {}) {
  await fetch(API(env.BOT_TOKEN, "sendPhoto"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id, photo: file_id, caption, parse_mode: "HTML", ...extra }),
  });
}
async function sendDocument(env: Env, chat_id: number | string, file_id: string, caption: string, extra: any = {}) {
  await fetch(API(env.BOT_TOKEN, "sendDocument"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id, document: file_id, caption, parse_mode: "HTML", ...extra }),
  });
}
async function answerCallback(env: Env, id: string) {
  await fetch(API(env.BOT_TOKEN, "answerCallbackQuery"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ callback_query_id: id }),
  });
}

// —— 让群里的 /cmd@bot 也能识别
function normalizeCommand(s: string) {
  const t = (s || "").trim();
  if (!t.startsWith("/")) return t;
  const parts = t.split(/\s+/);
  parts[0] = parts[0].split("@")[0];
  return parts.join(" ").trim();
}
const isPrivate = (msg: any) => msg?.chat?.type === "private";

// DB helpers
async function upsertUser(env: Env, from: any) {
  await env.credit_db
    .prepare(
      `INSERT INTO users (tg_user_id, username, full_name)
       VALUES (?, ?, ?)
       ON CONFLICT(tg_user_id) DO UPDATE
         SET username=excluded.username, full_name=excluded.full_name`
    )
    .bind(
      from.id,
      from.username || null,
      [from.first_name, from.last_name].filter(Boolean).join(" ") || null
    )
    .run();
}
async function getUserRow(env: Env, tgUserId: number) {
  return await env.credit_db
    .prepare(`SELECT id, tg_user_id, username, full_name, created_at FROM users WHERE tg_user_id=?`)
    .bind(tgUserId)
    .first<{ id: number; tg_user_id: number; username: string | null; full_name: string | null; created_at: string }>();
}
async function getUserId(env: Env, tgUserId: number) {
  const u = await env.credit_db.prepare(`SELECT id FROM users WHERE tg_user_id=?`).bind(tgUserId).first<{ id: number }>();
  return u?.id ?? null;
}
async function getBalance(env: Env, tgUserId: number) {
  const row = await env.credit_db
    .prepare(
      `SELECT COALESCE(SUM(amount),0) AS bal
         FROM credit_ledger
        WHERE user_id=(SELECT id FROM users WHERE tg_user_id=?)`
    )
    .bind(tgUserId)
    .first<{ bal: number }>();
  return row?.bal ?? 0;
}
async function listLedger(env: Env, tgUserId: number, limit = 5) {
  return await env.credit_db
    .prepare(
      `SELECT amount, type, ref_type, ref_id, note, created_at
         FROM credit_ledger
        WHERE user_id=(SELECT id FROM users WHERE tg_user_id=?)
        ORDER BY id DESC
        LIMIT ?`
    )
    .bind(tgUserId, limit)
    .all<{ amount: number; type: string; ref_type: string | null; ref_id: number | null; note: string | null; created_at: string }>();
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(req.url);
    if (pathname !== "/tg") return new Response("ok");
    if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

    const update = asJSON(await req.json());
    // console.log(JSON.stringify(update));

    // ====== 审核按钮 ======
    if ((update as any)?.callback_query) {
      const cq = (update as any).callback_query;
      const [action, idStr, amtStr] = (cq.data || "").split(":");
      const ticketId = parseInt(idStr, 10);
      const adminChatId = cq.message?.chat?.id;

      // 仅允许在管理员群/私聊中点击（这里先保留群校验）
      if (String(adminChatId) !== String(env.ADMIN_CHAT_ID)) {
        await answerCallback(env, cq.id);
        return new Response("ok");
      }

      if (action === "approve") {
        const amount = parseInt(amtStr, 10);
        await env.credit_db
          .prepare(
            `UPDATE topup_tickets
               SET status='APPROVED', audited_amount=?, audited_by=?, audited_at=CURRENT_TIMESTAMP
             WHERE id=? AND status='PENDING'`
          )
          .bind(amount, cq.from.id, ticketId)
          .run();

        const t = await env.credit_db.prepare(`SELECT user_id FROM topup_tickets WHERE id=?`).bind(ticketId).first<{ user_id: number }>();
        if (t) {
          await env.credit_db
            .prepare(
              `INSERT INTO credit_ledger (user_id, amount, type, ref_type, ref_id, note, created_by)
               VALUES (?, ?, 'TOPUP', 'TICKET', ?, ?, ?)`
            )
            .bind(t.user_id, amount, ticketId, `充值工单 #${ticketId}`, cq.from.id)
            .run();

          const u = await env.credit_db.prepare(`SELECT tg_user_id FROM users WHERE id=?`).bind(t.user_id).first<{ tg_user_id: number }>();
          if (u) await send(env, u.tg_user_id, `✅ 已核实，已为你入账 <b>${yuan(amount)}</b> 点数`);
        }
        await send(env, env.ADMIN_CHAT_ID, `✅ 已通过 #${ticketId}，入账 ${yuan(parseInt(amtStr, 10))}`);
      } else if (action === "reject") {
        await env.credit_db
          .prepare(
            `UPDATE topup_tickets
               SET status='REJECTED', audited_by=?, audited_at=CURRENT_TIMESTAMP
             WHERE id=? AND status='PENDING'`
          )
          .bind(cq.from.id, ticketId)
          .run();
        await send(env, env.ADMIN_CHAT_ID, `❌ 已拒绝 #${ticketId}`);
      }

      await answerCallback(env, cq.id);
      return new Response("ok");
    }

    // ====== 普通消息 ======
    if ((update as any)?.message) {
      const msg = (update as any).message;
      const chatId = msg.chat.id;
      const rawText: string = (msg.text || "").trim();
      const text = normalizeCommand(rawText);
      const from = msg.from;

      await upsertUser(env, from);

      // 私聊欢迎
      if (text === "/start") {
        await send(
          env,
          chatId,
          `你好～我是充值与点数助手 🤖
指令：
• <b>/topup 金额</b>（例如 <code>/topup 100.00</code>），随后发送转账截图
• <b>/balance</b> 查询当前点数
• <b>/me</b> 我的资料与近 5 笔流水
• <b>/help</b> 查看帮助

审核通过后会私信通知你入账金额。`
        );
        return new Response("ok");
      }

      if (text === "/help") {
        await send(
          env,
          chatId,
          `可用指令：
• <b>/topup 金额</b>（如 <code>/topup 100.00</code>），随后发送转账截图
• <b>/balance</b> 查询当前点数
• <b>/me</b> 我的资料 + 最近 5 笔流水
说明：金额展示单位为“元”，系统内部以“分”存储。`
        );
        return new Response("ok");
      }

      if (text === "/id") {
        await send(env, chatId, `chat_id: <code>${chatId}</code>`);
        return new Response("ok");
      }

      if (text === "/balance") {
        const bal = await getBalance(env, from.id);
        await send(env, chatId, `你当前点数：<b>${yuan(bal)}</b>`);
        return new Response("ok");
      }

      if (text === "/me") {
        const u = await getUserRow(env, from.id);
        const bal = await getBalance(env, from.id);
        const list = await listLedger(env, from.id, 5);
        const ledgerText =
          list?.results?.length
            ? list.results
                .map((r) => {
                  const sign = r.amount >= 0 ? "+" : "–";
                  const amt = yuan(Math.abs(r.amount));
                  const ref = r.ref_type && r.ref_id ? `（${r.ref_type} #${r.ref_id}）` : "";
                  const note = r.note ? `，${r.note}` : "";
                  return `${r.created_at}｜${r.type}${ref}｜${sign}${amt}${note}`;
                })
                .join("\n")
            : "（无记录）";
        await send(
          env,
          chatId,
          `👤 <b>我的资料</b>
ID：<code>${u?.tg_user_id ?? from.id}</code>
用户名：${u?.username ? "@" + u.username : "（无）"}
昵称：${u?.full_name ?? "（无）"}
注册时间：${u?.created_at ?? "（未知）"}
当前点数：<b>${yuan(bal)}</b>

📒 <b>最近 5 笔流水</b>
${ledgerText}`
        );
        return new Response("ok");
      }

      // —— 仅在“私聊”允许充值请求
      if (text.startsWith("/topup")) {
        if (!isPrivate(msg)) {
          await send(env, chatId, "为保护隐私，请在<b>私聊</b>里发送 <code>/topup 金额</code> 并上传截图。");
          return new Response("ok");
        }
        const amt = (text.split(/\s+/)[1] || "").trim();
        const cents = Math.round(parseFloat(amt) * 100);
        if (!Number.isFinite(cents) || cents <= 0) {
          await send(env, chatId, "用法示例：<code>/topup 100.00</code>\n然后发送转账截图即可创建工单。");
          return new Response("ok");
        }
        const userId = await getUserId(env, from.id);
        if (!userId) {
          await send(env, chatId, "内部错误：未找到用户，请重试 /start");
          return new Response("ok");
        }
        const res = await env.credit_db
          .prepare(`INSERT INTO topup_tickets (user_id, declared_amount) VALUES (?, ?)`)
          .bind(userId, cents)
          .run();
        const ticketId = res.meta.last_row_id;
        await send(env, chatId, `已创建充值工单 <b>#${ticketId}</b>（申报 ${yuan(cents)}）\n请现在发送转账截图～`);
        return new Response("ok");
      }

      // —— 仅在“私聊”接收凭证，并把图片转发给管理员
      if (msg.photo || msg.document) {
        if (!isPrivate(msg)) {
          await send(env, chatId, "为保护隐私，请在<b>私聊</b>里上传转账截图。");
          return new Response("ok");
        }

        const isPhoto = !!msg.photo;
        const fileId = (msg.photo?.slice(-1)[0] || msg.document)?.file_id;

        await env.credit_db
          .prepare(
            `UPDATE topup_tickets SET proof_file_id=?
             WHERE id=(
               SELECT id FROM topup_tickets
                WHERE user_id=(SELECT id FROM users WHERE tg_user_id=?)
                  AND status='PENDING'
                ORDER BY id DESC LIMIT 1
             )`
          )
          .bind(fileId, from.id)
          .run();

        const ticket = await env.credit_db
          .prepare(
            `SELECT t.id, u.username, t.declared_amount, t.proof_file_id
               FROM topup_tickets t JOIN users u ON u.id=t.user_id
              WHERE t.user_id=(SELECT id FROM users WHERE tg_user_id=?)
                AND t.status='PENDING'
              ORDER BY t.id DESC LIMIT 1`
          )
          .bind(from.id)
          .first<{ id: number; username: string | null; declared_amount: number; proof_file_id: string | null }>();

        if (ticket) {
          const caption =
            `💳 充值工单 #${ticket.id}\n` +
            `来自：@${ticket.username ?? from.id}\n` +
            `申报金额：${yuan(ticket.declared_amount)}\n` +
            `凭证：✅ 已上传`;
          const markup = {
            reply_markup: {
              inline_keyboard: [[
                { text: "✅ 通过（同额）", callback_data: `approve:${ticket.id}:${ticket.declared_amount}` },
                { text: "❌ 拒绝",        callback_data: `reject:${ticket.id}` }
              ]]
            }
          };
          // 直接把图片/文件发给管理员
          if (isPhoto) {
            await sendPhoto(env, env.ADMIN_CHAT_ID, fileId!, caption, markup);
          } else {
            await sendDocument(env, env.ADMIN_CHAT_ID, fileId!, caption, markup);
          }
          await send(env, chatId, `收到截图 ✅ 工单 <b>#${ticket.id}</b> 已提交审核，请稍候～`);
        } else {
          await send(env, chatId, "没有找到待审核工单，请先发送 <code>/topup 金额</code>。");
        }
        return new Response("ok");
      }

      await send(env, chatId, "不认识的指令～请试：<b>/topup</b>、<b>/balance</b>、<b>/me</b>");
      return new Response("ok");
    }

    return new Response("ok");
  },
} satisfies ExportedHandler<Env>;
