-- users
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tg_user_id INTEGER UNIQUE NOT NULL,
  username TEXT,
  full_name TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- credit_ledger：账本（以“分”为单位）
CREATE TABLE IF NOT EXISTS credit_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  amount INTEGER NOT NULL,               -- 正加负减（分）
  type TEXT NOT NULL,                    -- TOPUP / ADJUST / DEBIT
  ref_type TEXT,                         -- TICKET / ADMIN / ORDER
  ref_id INTEGER,
  note TEXT,
  created_by INTEGER,                    -- 管理员 tg id
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

-- topup_tickets：充值工单
CREATE TABLE IF NOT EXISTS topup_tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING',  -- PENDING / APPROVED / REJECTED
  declared_amount INTEGER NOT NULL,        -- 申报金额（分）
  proof_file_id TEXT,                      -- 转账截图 file_id
  audited_amount INTEGER,                  -- 实际入账（分）
  audited_by INTEGER,                      -- 管理员 tg id
  audited_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

-- roles：权限
CREATE TABLE IF NOT EXISTS roles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tg_user_id INTEGER UNIQUE NOT NULL,
  role TEXT NOT NULL                      -- ADMIN / AGENT / USER
);
