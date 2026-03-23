const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

require("dotenv").config({ quiet: true });


const bcrypt = require("bcryptjs");
const Database = require("better-sqlite3");
const express = require("express");
const nodemailer = require("nodemailer");

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, "kangqei-demo.db");

fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

const referenceProfiles = [
  {
    id: "rehab_cardiac",
    name: "心肺康复用户",
    conditionType: "心肺康复",
    rehabStage: "术后中期",
    sensitivity: 1.35,
    recommendedDuration: 30,
    maxSafeHeartRate: 125,
    description: "需要更早识别高速逼近风险，避免急转头和惊吓。",
  },
  {
    id: "rehab_orthopedic",
    name: "骨科术后用户",
    conditionType: "骨科术后",
    rehabStage: "恢复训练期",
    sensitivity: 1.25,
    recommendedDuration: 25,
    maxSafeHeartRate: 135,
    description: "更关注转头受限、车身偏移和危险超车场景。",
  },
  {
    id: "elderly",
    name: "老年健康管理用户",
    conditionType: "老年健康管理",
    rehabStage: "日常健康管理",
    sensitivity: 1.45,
    recommendedDuration: 20,
    maxSafeHeartRate: 115,
    description: "对接近速度和距离更敏感，预警会更提前。",
  },
  {
    id: "standard",
    name: "普通体验用户",
    conditionType: "体验模式",
    rehabStage: "体验模式",
    sensitivity: 1.0,
    recommendedDuration: 35,
    maxSafeHeartRate: 150,
    description: "用于展示普通用户与康复用户在阈值上的差异。",
  },
];

const scenarios = [
  {
    id: "city_lane",
    name: "城市慢行道路",
    durationTicks: 14,
    description: "有普通来车、快速逼近和一次危险超车，适合完整演示主流程。",
  },
  {
    id: "rehab_greenway",
    name: "康复绿道",
    durationTicks: 12,
    description: "整体风险较低，强调轻提醒和路线建议。",
  },
  {
    id: "mixed_traffic",
    name: "混行道路",
    durationTicks: 14,
    description: "机动车与电动车混行，更容易出现连续中高风险事件。",
  },
];

const patientStatuses = [
  "适合继续户外骑行",
  "户外骑行需谨慎",
  "建议改为室内训练",
];

const activeRides = new Map();
let mailTransporter = null;

app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public")));

function initDatabase() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('patient', 'doctor', 'family')),
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS patient_profiles (
      user_id INTEGER PRIMARY KEY,
      template_profile_id TEXT NOT NULL,
      age INTEGER,
      gender TEXT,
      condition_type TEXT NOT NULL,
      rehab_stage TEXT NOT NULL,
      risk_sensitivity REAL NOT NULL,
      recommended_duration INTEGER NOT NULL,
      max_safe_heart_rate INTEGER NOT NULL,
      doctor_threshold_adjustment REAL NOT NULL DEFAULT 1.0,
      patient_status TEXT NOT NULL DEFAULT '适合继续户外骑行',
      status_updated_at TEXT NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS family_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      family_user_id INTEGER NOT NULL,
      patient_user_id INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(family_user_id, patient_user_id),
      FOREIGN KEY(family_user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY(patient_user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS ride_sessions (
      id TEXT PRIMARY KEY,
      patient_user_id INTEGER NOT NULL,
      scenario_id TEXT NOT NULL,
      scenario_name TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at TEXT,
      ended_at TEXT,
      latest_tick INTEGER NOT NULL DEFAULT 0,
      total_risk_events INTEGER NOT NULL DEFAULT 0,
      avg_risk_score REAL NOT NULL DEFAULT 0,
      final_safety_score INTEGER,
      created_at TEXT NOT NULL,
      FOREIGN KEY(patient_user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS risk_events (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      patient_user_id INTEGER NOT NULL,
      tick INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      risk_level TEXT NOT NULL,
      distance REAL NOT NULL,
      relative_speed REAL NOT NULL,
      ttc REAL,
      direction TEXT NOT NULL,
      reason TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(session_id) REFERENCES ride_sessions(id) ON DELETE CASCADE,
      FOREIGN KEY(patient_user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL UNIQUE,
      patient_user_id INTEGER NOT NULL,
      report_json TEXT NOT NULL,
      generated_at TEXT NOT NULL,
      FOREIGN KEY(session_id) REFERENCES ride_sessions(id) ON DELETE CASCADE,
      FOREIGN KEY(patient_user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS doctor_actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      doctor_user_id INTEGER NOT NULL,
      patient_user_id INTEGER NOT NULL,
      action_type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(doctor_user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY(patient_user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      related_session_id TEXT,
      category TEXT NOT NULL,
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      is_read INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS auth_tokens (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      last_used_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      revoked_at TEXT,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS email_deliveries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT,
      recipient_email TEXT NOT NULL,
      recipient_role TEXT NOT NULL,
      subject TEXT NOT NULL,
      status TEXT NOT NULL,
      provider_message_id TEXT,
      error_message TEXT,
      created_at TEXT NOT NULL,
      sent_at TEXT
    );
  `);

  ensureColumnExists("ride_sessions", "start_lat", "REAL");
  ensureColumnExists("ride_sessions", "start_lng", "REAL");
  ensureColumnExists("ride_sessions", "start_accuracy", "REAL");
}

function ensureColumnExists(tableName, columnName, definition) {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all();
  const exists = columns.some((column) => column.name === columnName);
  if (!exists) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  }
}

function nowIso() {
  return new Date().toISOString();
}

function makeId(prefix) {
  return `${prefix}_${crypto.randomUUID().slice(0, 8)}`;
}

function round(value, precision = 1) {
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}

function kmhToMs(speed) {
  return speed / 3.6;
}

function getReferenceProfile(profileId) {
  return referenceProfiles.find((item) => item.id === profileId);
}

function getScenario(scenarioId) {
  return scenarios.find((item) => item.id === scenarioId);
}

function parseJson(jsonText, fallback) {
  try {
    return JSON.parse(jsonText);
  } catch {
    return fallback;
  }
}

function serializeUser(userRow) {
  if (!userRow) {
    return null;
  }
  return {
    id: userRow.id,
    name: userRow.name,
    email: userRow.email,
    role: userRow.role,
    createdAt: userRow.created_at,
  };
}

function getUserById(userId) {
  return db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
}

function getUserByEmail(email) {
  return db.prepare("SELECT * FROM users WHERE email = ?").get(email.trim().toLowerCase());
}

function getPatientProfile(userId) {
  const row = db.prepare("SELECT * FROM patient_profiles WHERE user_id = ?").get(userId);
  if (!row) {
    return null;
  }
  return {
    userId: row.user_id,
    templateProfileId: row.template_profile_id,
    age: row.age,
    gender: row.gender,
    conditionType: row.condition_type,
    rehabStage: row.rehab_stage,
    riskSensitivity: row.risk_sensitivity,
    recommendedDuration: row.recommended_duration,
    maxSafeHeartRate: row.max_safe_heart_rate,
    doctorThresholdAdjustment: row.doctor_threshold_adjustment,
    patientStatus: row.patient_status,
    statusUpdatedAt: row.status_updated_at,
    effectiveSensitivity: round(row.risk_sensitivity * row.doctor_threshold_adjustment, 2),
  };
}

function getFullUserContext(userId) {
  const user = getUserById(userId);
  if (!user) {
    return null;
  }

  const context = { user: serializeUser(user) };
  if (user.role === "patient") {
    context.patientProfile = getPatientProfile(user.id);
  }
  return context;
}

function buildAuthResponse(userId, token) {
  return {
    token,
    ...getFullUserContext(userId),
  };
}

function isEmailEnabled() {
  return Boolean(
    process.env.SMTP_HOST &&
      process.env.SMTP_PORT &&
      process.env.SMTP_USER &&
      process.env.SMTP_PASS &&
      process.env.SMTP_FROM,
  );
}

function getMailTransporter() {
  if (!isEmailEnabled()) {
    return null;
  }
  if (!mailTransporter) {
    mailTransporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT),
      secure: String(process.env.SMTP_SECURE || "false").toLowerCase() === "true",
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });
  }
  return mailTransporter;
}

function getMailFromAddress() {
  const name = process.env.SMTP_FROM_NAME || "康骑卫士平台";
  return `"${name}" <${process.env.SMTP_FROM}>`;
}

function buildReportMailHtml({ recipientName, patientName, report }) {
  const recommendationItems = report.recommendations
    .map((item) => `<li style="margin-bottom:8px;">${item}</li>`)
    .join("");

  return `
    <div style="font-family:Arial,Helvetica,sans-serif;max-width:680px;margin:0 auto;padding:24px;color:#1f1a16;">
      <h1 style="margin:0 0 12px;font-size:28px;">康骑卫士骑行报告</h1>
      <p style="margin:0 0 18px;line-height:1.7;">${recipientName}，您好。${patientName} 的一次康复骑行报告已生成，以下是本次结果摘要。</p>

      <div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin-bottom:20px;">
        <div style="padding:16px;border:1px solid #e7ddd2;border-radius:16px;background:#fffaf5;">
          <div style="color:#6c655f;font-size:13px;">安全评分</div>
          <div style="font-size:28px;font-weight:700;margin-top:8px;">${report.safetyScore}</div>
        </div>
        <div style="padding:16px;border:1px solid #e7ddd2;border-radius:16px;background:#fffaf5;">
          <div style="color:#6c655f;font-size:13px;">高风险事件</div>
          <div style="font-size:28px;font-weight:700;margin-top:8px;">${report.highRiskCount}</div>
        </div>
        <div style="padding:16px;border:1px solid #e7ddd2;border-radius:16px;background:#fffaf5;">
          <div style="color:#6c655f;font-size:13px;">骑行时长</div>
          <div style="font-size:24px;font-weight:700;margin-top:8px;">${report.rideDurationMinutes} 分钟</div>
        </div>
        <div style="padding:16px;border:1px solid #e7ddd2;border-radius:16px;background:#fffaf5;">
          <div style="color:#6c655f;font-size:13px;">总预警数</div>
          <div style="font-size:24px;font-weight:700;margin-top:8px;">${report.totalAlerts}</div>
        </div>
      </div>

      <div style="padding:18px;border-radius:18px;background:#f5efe6;border:1px solid #e4d8ca;margin-bottom:18px;">
        <div style="font-weight:700;margin-bottom:8px;">场景</div>
        <div style="line-height:1.7;">${report.scenarioName}</div>
        <div style="font-weight:700;margin:14px 0 8px;">医生建议</div>
        <div style="line-height:1.7;">${report.doctorComment}</div>
      </div>

      <div style="padding:18px;border-radius:18px;background:#f5efe6;border:1px solid #e4d8ca;">
        <div style="font-weight:700;margin-bottom:8px;">路线建议</div>
        <ul style="padding-left:20px;line-height:1.7;margin:0;">${recommendationItems}</ul>
      </div>
    </div>
  `;
}

function buildReportMailText({ recipientName, patientName, report }) {
  return [
    `${recipientName}，您好。`,
    `${patientName} 的一次康复骑行报告已生成。`,
    ``,
    `场景：${report.scenarioName}`,
    `安全评分：${report.safetyScore}`,
    `骑行时长：${report.rideDurationMinutes} 分钟`,
    `总预警数：${report.totalAlerts}`,
    `高风险事件：${report.highRiskCount}`,
    `医生建议：${report.doctorComment}`,
    `路线建议：`,
    ...report.recommendations.map((item, index) => `${index + 1}. ${item}`),
  ].join("\n");
}

function recordEmailDelivery({ sessionId, recipientEmail, recipientRole, subject, status, providerMessageId = null, errorMessage = null, sentAt = null }) {
  db.prepare(`
    INSERT INTO email_deliveries (
      session_id, recipient_email, recipient_role, subject, status,
      provider_message_id, error_message, created_at, sent_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    sessionId,
    recipientEmail,
    recipientRole,
    subject,
    status,
    providerMessageId,
    errorMessage,
    nowIso(),
    sentAt,
  );
}

function getReportMailRecipients(patientUserId) {
  const recipients = [];
  const patient = getUserById(patientUserId);
  if (patient) {
    recipients.push({
      email: patient.email,
      name: patient.name,
      role: "patient",
    });
  }

  const familyRows = db
    .prepare(
      `
      SELECT u.email, u.name
      FROM family_links fl
      JOIN users u ON u.id = fl.family_user_id
      WHERE fl.patient_user_id = ?
    `,
    )
    .all(patientUserId);

  familyRows.forEach((row) => {
    recipients.push({
      email: row.email,
      name: row.name,
      role: "family",
    });
  });

  return recipients.filter((recipient, index, all) => all.findIndex((item) => item.email === recipient.email) === index);
}

async function sendRideReportEmails(rideState) {
  const recipients = getReportMailRecipients(rideState.patientUserId);
  if (!recipients.length) {
    return;
  }

  const subject = `康骑卫士骑行报告 | ${rideState.user.name} | ${rideState.report.scenarioName}`;

  if (!isEmailEnabled()) {
    recipients.forEach((recipient) => {
      recordEmailDelivery({
        sessionId: rideState.id,
        recipientEmail: recipient.email,
        recipientRole: recipient.role,
        subject,
        status: "skipped",
        errorMessage: "SMTP not configured",
      });
    });
    return;
  }

  const transporter = getMailTransporter();
  for (const recipient of recipients) {
    try {
      const info = await transporter.sendMail({
        from: getMailFromAddress(),
        to: recipient.email,
        subject,
        text: buildReportMailText({
          recipientName: recipient.name,
          patientName: rideState.user.name,
          report: rideState.report,
        }),
        html: buildReportMailHtml({
          recipientName: recipient.name,
          patientName: rideState.user.name,
          report: rideState.report,
        }),
      });

      recordEmailDelivery({
        sessionId: rideState.id,
        recipientEmail: recipient.email,
        recipientRole: recipient.role,
        subject,
        status: "sent",
        providerMessageId: info.messageId || null,
        sentAt: nowIso(),
      });
    } catch (error) {
      recordEmailDelivery({
        sessionId: rideState.id,
        recipientEmail: recipient.email,
        recipientRole: recipient.role,
        subject,
        status: "failed",
        errorMessage: error.message,
      });
      console.error(`Failed to send report email to ${recipient.email}: ${error.message}`);
    }
  }
}

function createAccessToken(userId) {
  const token = crypto.randomBytes(32).toString("hex");
  const createdAt = nowIso();
  const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 7).toISOString();
  db.prepare(`
    INSERT INTO auth_tokens (token, user_id, created_at, last_used_at, expires_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(token, userId, createdAt, createdAt, expiresAt);
  return token;
}

function getRequestToken(req) {
  const authHeader = req.headers.authorization || "";
  if (authHeader.startsWith("Bearer ")) {
    return authHeader.slice("Bearer ".length).trim();
  }
  if (typeof req.query.token === "string" && req.query.token) {
    return req.query.token;
  }
  return null;
}

function revokeToken(token) {
  if (!token) {
    return;
  }
  db.prepare("UPDATE auth_tokens SET revoked_at = ? WHERE token = ?").run(nowIso(), token);
}

function getUserFromToken(token) {
  if (!token) {
    return null;
  }
  const row = db
    .prepare(
      `
      SELECT u.*, t.token, t.expires_at, t.revoked_at
      FROM auth_tokens t
      JOIN users u ON u.id = t.user_id
      WHERE t.token = ?
    `,
    )
    .get(token);

  if (!row) {
    return null;
  }

  if (row.revoked_at || new Date(row.expires_at).getTime() <= Date.now()) {
    return null;
  }

  db.prepare("UPDATE auth_tokens SET last_used_at = ? WHERE token = ?").run(nowIso(), token);
  return row;
}

function requireAuth(req, res, next) {
  const token = getRequestToken(req);
  if (!token) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const user = getUserFromToken(token);
  if (!user) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  req.user = user;
  req.accessToken = token;
  next();
}

function requireRole(roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    next();
  };
}

function buildTargets(scenarioId, tick) {
  if (scenarioId === "rehab_greenway") {
    if (tick <= 3) {
      return [
        {
          id: "bike_01",
          distance: 24 - tick * 2,
          relativeSpeed: 8,
          direction: "rear_left",
          type: "bike",
          dangerousOvertake: false,
        },
      ];
    }
    if (tick <= 6) {
      return [
        {
          id: "scooter_01",
          distance: 18 - (tick - 3) * 2.6,
          relativeSpeed: 14,
          direction: "rear_center",
          type: "scooter",
          dangerousOvertake: false,
        },
      ];
    }
    if (tick <= 9) {
      return [
        {
          id: "car_01",
          distance: 16 - (tick - 6) * 2.5,
          relativeSpeed: 18,
          direction: "rear_right",
          type: "car",
          dangerousOvertake: tick >= 8,
        },
      ];
    }
    return [];
  }

  if (scenarioId === "mixed_traffic") {
    if (tick <= 4) {
      return [
        {
          id: "scooter_01",
          distance: 22 - tick * 2.5,
          relativeSpeed: 16,
          direction: "rear_left",
          type: "scooter",
          dangerousOvertake: false,
        },
        {
          id: "bike_02",
          distance: 18 - tick * 1.2,
          relativeSpeed: 9,
          direction: "rear_right",
          type: "bike",
          dangerousOvertake: false,
        },
      ];
    }
    if (tick <= 8) {
      return [
        {
          id: "car_01",
          distance: 17 - (tick - 4) * 3.1,
          relativeSpeed: 25,
          direction: "rear_center",
          type: "car",
          dangerousOvertake: tick >= 7,
        },
        {
          id: "scooter_02",
          distance: 11 - (tick - 4) * 1.5,
          relativeSpeed: 13,
          direction: "rear_left",
          type: "scooter",
          dangerousOvertake: false,
        },
      ];
    }
    if (tick <= 11) {
      return [
        {
          id: "van_01",
          distance: 12 - (tick - 8) * 2.8,
          relativeSpeed: 28,
          direction: "rear_right",
          type: "van",
          dangerousOvertake: true,
        },
      ];
    }
    return [
      {
        id: "bike_03",
        distance: 16 - (tick - 11) * 1.5,
        relativeSpeed: 10,
        direction: "rear_left",
        type: "bike",
        dangerousOvertake: false,
      },
    ];
  }

  if (tick <= 4) {
    return [
      {
        id: "car_01",
        distance: 26 - tick * 2.2,
        relativeSpeed: 12,
        direction: "rear_left",
        type: "car",
        dangerousOvertake: false,
      },
    ];
  }
  if (tick <= 8) {
    return [
      {
        id: "car_02",
        distance: 19 - (tick - 4) * 3.2,
        relativeSpeed: 24,
        direction: "rear_center",
        type: "car",
        dangerousOvertake: false,
      },
    ];
  }
  if (tick <= 11) {
    return [
      {
        id: "van_01",
        distance: 10 - (tick - 8) * 2.3,
        relativeSpeed: 27,
        direction: "rear_right",
        type: "van",
        dangerousOvertake: true,
      },
    ];
  }
  return [
    {
      id: "bike_01",
      distance: 18 - (tick - 11) * 2,
      relativeSpeed: 11,
      direction: "rear_left",
      type: "bike",
      dangerousOvertake: false,
    },
  ];
}

function getDirectionLabel(direction) {
  if (direction === "rear_left") return "左后方";
  if (direction === "rear_right") return "右后方";
  return "正后方";
}

function evaluateRisk(targets, profile) {
  if (!targets.length) {
    return {
      level: "safe",
      score: 0,
      reason: "周围后方暂无目标，保持当前节奏即可。",
      ttc: null,
      primaryTarget: null,
      alertMode: "idle",
    };
  }

  const scoredTargets = targets.map((target) => {
    const ttc = round(target.distance / Math.max(kmhToMs(target.relativeSpeed), 0.5), 1);
    const distanceScore = Math.max(0, 30 - target.distance) * 2.2;
    const speedScore = target.relativeSpeed * 1.6;
    const overtakeScore = target.dangerousOvertake ? 24 : 0;
    const score = (distanceScore + speedScore + overtakeScore) * profile.effectiveSensitivity;
    return { ...target, ttc, score: round(score, 1) };
  });

  const primaryTarget = scoredTargets.sort((a, b) => b.score - a.score)[0];
  let level = "low";
  let alertMode = "soft";
  let reason = `${getDirectionLabel(primaryTarget.direction)}有目标接近，建议保持直行。`;

  if (primaryTarget.dangerousOvertake || primaryTarget.ttc <= 1.4 || primaryTarget.score >= 82) {
    level = "high";
    alertMode = "strong";
    reason = `${getDirectionLabel(primaryTarget.direction)}存在危险超车趋势，请减速并保持车身稳定。`;
  } else if (primaryTarget.ttc <= 2.6 || primaryTarget.score >= 54) {
    level = "medium";
    alertMode = "elevated";
    reason = `${getDirectionLabel(primaryTarget.direction)}车辆快速逼近，请避免回头并准备减速。`;
  }

  return {
    level,
    score: primaryTarget.score,
    reason,
    ttc: primaryTarget.ttc,
    primaryTarget,
    alertMode,
  };
}

function buildDeviceState(tick, risk) {
  const batteryDrain = Math.min(tick, 18);
  return {
    radarOnline: true,
    glassesOnline: true,
    appOnline: true,
    batteryLevel: 94 - batteryDrain,
    signalStrength: risk.level === "high" ? "高负载" : "稳定",
    lastHeartbeat: nowIso(),
  };
}

function buildLiveState(rideState) {
  const targets = buildTargets(rideState.scenario.id, rideState.tick).map((target) => ({
    ...target,
    distance: round(Math.max(target.distance, 1.2)),
  }));
  const risk = evaluateRisk(targets, rideState.profile);
  const deviceState = buildDeviceState(rideState.tick, risk);

  return {
    tick: rideState.tick,
    timestamp: nowIso(),
    targets,
    risk,
    deviceState,
  };
}

function countByLevel(events, level) {
  return events.filter((event) => event.riskLevel === level).length;
}

function createNotificationsForUsers(userIds, category, title, message, relatedSessionId = null) {
  const uniqueIds = [...new Set(userIds.filter(Boolean))];
  const stmt = db.prepare(`
    INSERT INTO notifications (user_id, related_session_id, category, title, message, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  uniqueIds.forEach((userId) => {
    stmt.run(userId, relatedSessionId, category, title, message, nowIso());
  });
}

function getLinkedFamilyIds(patientUserId) {
  return db
    .prepare("SELECT family_user_id FROM family_links WHERE patient_user_id = ?")
    .all(patientUserId)
    .map((row) => row.family_user_id);
}

function getDoctorIds() {
  return db
    .prepare("SELECT id FROM users WHERE role = 'doctor'")
    .all()
    .map((row) => row.id);
}

function buildRecommendations(rideState) {
  const highCount = countByLevel(rideState.events, "high");
  const mediumCount = countByLevel(rideState.events, "medium");
  const recommendations = [];

  if (highCount > 0) {
    recommendations.push("优先选择康复绿道或车流更少的路线。");
  }
  if (rideState.profile.templateProfileId === "rehab_cardiac") {
    recommendations.push("保持低强度骑行节奏，遇到连续逼近场景应尽早减速。");
  }
  if (rideState.profile.templateProfileId === "rehab_orthopedic") {
    recommendations.push("避免复杂混行道路，减少因转头观察引发的车身偏移。");
  }
  if (rideState.profile.templateProfileId === "elderly") {
    recommendations.push("建议缩短单次骑行时长，并优先选择固定时段出行。");
  }
  if (mediumCount === 0 && highCount === 0) {
    recommendations.push("当前路线较适合康复骑行，可继续保持。");
  }

  return recommendations.slice(0, 3);
}

function buildDoctorComment(rideState, safetyScore) {
  if (safetyScore >= 85) {
    return "本次骑行总体稳定，可维持当前低强度训练计划。";
  }
  if (safetyScore >= 70) {
    return "出现少量风险事件，建议继续户外骑行但应优化路线。";
  }
  return "本次高风险事件偏多，建议暂时下调训练强度并避开混行道路。";
}

function generateReport(rideState) {
  const durationMinutes = Math.max(1, Math.round(rideState.timeline.length * 0.8));
  const highCount = countByLevel(rideState.events, "high");
  const mediumCount = countByLevel(rideState.events, "medium");
  const lowCount = countByLevel(rideState.events, "low");
  const safetyScore = Math.max(38, 100 - highCount * 18 - mediumCount * 7 - lowCount * 2);
  const highestRiskEvent = rideState.events.find((event) => event.riskLevel === "high") || rideState.events[0] || null;

  return {
    sessionId: rideState.id,
    patientUserId: rideState.patientUserId,
    userName: rideState.user.name,
    scenarioName: rideState.scenario.name,
    rideDurationMinutes: durationMinutes,
    totalAlerts: rideState.events.length,
    highRiskCount: highCount,
    mediumRiskCount: mediumCount,
    safetyScore,
    highestRiskMoment: highestRiskEvent
      ? {
          tick: highestRiskEvent.tick,
          direction: getDirectionLabel(highestRiskEvent.direction),
          reason: highestRiskEvent.reason,
        }
      : null,
    recommendations: buildRecommendations(rideState),
    doctorComment: buildDoctorComment(rideState, safetyScore),
    generatedAt: nowIso(),
  };
}

function persistReport(rideState, report) {
  db.prepare(`
    INSERT INTO reports (session_id, patient_user_id, report_json, generated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      report_json = excluded.report_json,
      generated_at = excluded.generated_at
  `).run(rideState.id, rideState.patientUserId, JSON.stringify(report), report.generatedAt);

  db.prepare(`
    UPDATE ride_sessions
    SET final_safety_score = ?, ended_at = ?, status = 'finished', latest_tick = ?, total_risk_events = ?, avg_risk_score = ?
    WHERE id = ?
  `).run(
    report.safetyScore,
    rideState.endedAt,
    rideState.tick,
    rideState.events.length,
    rideState.riskSamples === 0 ? 0 : round(rideState.riskScoreTotal / rideState.riskSamples, 1),
    rideState.id,
  );
}

function getLatestReportByPatient(patientUserId) {
  const row = db
    .prepare(
      `
      SELECT report_json FROM reports
      WHERE patient_user_id = ?
      ORDER BY generated_at DESC
      LIMIT 1
    `,
    )
    .get(patientUserId);

  return row ? parseJson(row.report_json, null) : null;
}

function getRideEvents(sessionId) {
  return db
    .prepare(
      `
      SELECT id, tick, event_type, risk_level, distance, relative_speed, ttc, direction, reason, created_at
      FROM risk_events
      WHERE session_id = ?
      ORDER BY tick ASC, created_at ASC
    `,
    )
    .all(sessionId)
    .map((row) => ({
      id: row.id,
      tick: row.tick,
      eventType: row.event_type,
      riskLevel: row.risk_level,
      distance: row.distance,
      relativeSpeed: row.relative_speed,
      ttc: row.ttc,
      direction: row.direction,
      reason: row.reason,
      createdAt: row.created_at,
    }));
}

function getRideSummary(sessionId) {
  const sessionRow = db.prepare("SELECT * FROM ride_sessions WHERE id = ?").get(sessionId);
  if (!sessionRow) {
    return null;
  }
  const reportRow = db.prepare("SELECT * FROM reports WHERE session_id = ?").get(sessionId);
  const patient = getUserById(sessionRow.patient_user_id);

  return {
    id: sessionRow.id,
    patientUserId: sessionRow.patient_user_id,
    patientName: patient ? patient.name : "未知用户",
    scenarioId: sessionRow.scenario_id,
    scenarioName: sessionRow.scenario_name,
    status: sessionRow.status,
    startedAt: sessionRow.started_at,
    endedAt: sessionRow.ended_at,
    latestTick: sessionRow.latest_tick,
    startLocation:
      sessionRow.start_lat != null && sessionRow.start_lng != null
        ? {
            lat: sessionRow.start_lat,
            lng: sessionRow.start_lng,
            accuracy: sessionRow.start_accuracy,
          }
        : null,
    totalRiskEvents: sessionRow.total_risk_events,
    avgRiskScore: sessionRow.avg_risk_score,
    finalSafetyScore: sessionRow.final_safety_score,
    report: reportRow ? parseJson(reportRow.report_json, null) : null,
    events: getRideEvents(sessionId),
  };
}

function getEmailDeliveriesForSession(sessionId) {
  return db
    .prepare(
      `
      SELECT recipient_email, recipient_role, subject, status, provider_message_id, error_message, created_at, sent_at
      FROM email_deliveries
      WHERE session_id = ?
      ORDER BY id DESC
    `,
    )
    .all(sessionId)
    .map((row) => ({
      recipientEmail: row.recipient_email,
      recipientRole: row.recipient_role,
      subject: row.subject,
      status: row.status,
      providerMessageId: row.provider_message_id,
      errorMessage: row.error_message,
      createdAt: row.created_at,
      sentAt: row.sent_at,
    }));
}

function getRecentRidesForPatient(patientUserId, limit = 5) {
  return db
    .prepare(
      `
      SELECT id
      FROM ride_sessions
      WHERE patient_user_id = ?
      ORDER BY COALESCE(ended_at, started_at, created_at) DESC
      LIMIT ?
    `,
    )
    .all(patientUserId, limit)
    .map((row) => getRideSummary(row.id));
}

function getNotificationsForUser(userId) {
  return db
    .prepare(
      `
      SELECT id, related_session_id, category, title, message, is_read, created_at
      FROM notifications
      WHERE user_id = ?
      ORDER BY is_read ASC, created_at DESC
      LIMIT 30
    `,
    )
    .all(userId)
    .map((row) => ({
      id: row.id,
      relatedSessionId: row.related_session_id,
      category: row.category,
      title: row.title,
      message: row.message,
      isRead: Boolean(row.is_read),
      createdAt: row.created_at,
    }));
}

function serializeRideState(rideState) {
  return {
    id: rideState.id,
    patientUserId: rideState.patientUserId,
    patientName: rideState.user.name,
    status: rideState.status,
    scenario: rideState.scenario,
    startLocation: rideState.startLocation,
    startedAt: rideState.startedAt,
    endedAt: rideState.endedAt,
    currentState: rideState.currentState,
    events: rideState.events,
    report: rideState.report,
    profile: rideState.profile,
  };
}

function broadcastRide(rideState, payload) {
  const eventData = `data: ${JSON.stringify(payload)}\n\n`;
  rideState.clients.forEach((client) => client.write(eventData));
}

function maybeStoreRiskEvent(rideState, liveState) {
  const { risk } = liveState;
  if (!["low", "medium", "high"].includes(risk.level)) {
    return;
  }

  const target = risk.primaryTarget;
  if (!target) {
    return;
  }

  const lastEvent = rideState.events[rideState.events.length - 1];
  const shouldStore =
    !lastEvent ||
    lastEvent.riskLevel !== risk.level ||
    lastEvent.direction !== target.direction ||
    (risk.level === "high" && lastEvent.tick !== liveState.tick);

  if (!shouldStore) {
    return;
  }

  const event = {
    id: makeId("event"),
    tick: liveState.tick,
    eventType: risk.level === "high" ? "dangerous_overtake" : "rear_vehicle_alert",
    riskLevel: risk.level,
    distance: target.distance,
    relativeSpeed: target.relativeSpeed,
    ttc: risk.ttc,
    direction: target.direction,
    reason: risk.reason,
    createdAt: liveState.timestamp,
  };

  rideState.events.push(event);

  db.prepare(`
    INSERT INTO risk_events (
      id, session_id, patient_user_id, tick, event_type, risk_level, distance, relative_speed, ttc, direction, reason, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    event.id,
    rideState.id,
    rideState.patientUserId,
    event.tick,
    event.eventType,
    event.riskLevel,
    event.distance,
    event.relativeSpeed,
    event.ttc,
    event.direction,
    event.reason,
    event.createdAt,
  );

  db.prepare(`
    UPDATE ride_sessions
    SET total_risk_events = ?, latest_tick = ?, avg_risk_score = ?
    WHERE id = ?
  `).run(
    rideState.events.length,
    liveState.tick,
    rideState.riskSamples === 0 ? 0 : round(rideState.riskScoreTotal / rideState.riskSamples, 1),
    rideState.id,
  );

  if (event.riskLevel === "high") {
    const doctorIds = getDoctorIds();
    const familyIds = getLinkedFamilyIds(rideState.patientUserId);
    createNotificationsForUsers(
      [...doctorIds, ...familyIds],
      "high_risk",
      "检测到高风险骑行事件",
      `${rideState.user.name} 在 ${rideState.scenario.name} 中出现高风险超车，请尽快关注。`,
      rideState.id,
    );
  }
}

function advanceRide(rideState) {
  rideState.tick += 1;
  rideState.currentState = buildLiveState(rideState);
  rideState.timeline.push(rideState.currentState);
  rideState.riskScoreTotal += rideState.currentState.risk.score || 0;
  rideState.riskSamples += 1;

  maybeStoreRiskEvent(rideState, rideState.currentState);

  db.prepare(`
    UPDATE ride_sessions
    SET latest_tick = ?, avg_risk_score = ?
    WHERE id = ?
  `).run(
    rideState.tick,
    rideState.riskSamples === 0 ? 0 : round(rideState.riskScoreTotal / rideState.riskSamples, 1),
    rideState.id,
  );

  broadcastRide(rideState, {
    type: "ride_update",
    ride: serializeRideState(rideState),
  });

  if (rideState.tick >= rideState.scenario.durationTicks) {
    finishRide(rideState);
  }
}

function finishRide(rideState) {
  if (rideState.status === "finished") {
    return rideState;
  }

  if (rideState.interval) {
    clearInterval(rideState.interval);
    rideState.interval = null;
  }

  rideState.status = "finished";
  rideState.endedAt = nowIso();
  rideState.report = generateReport(rideState);
  persistReport(rideState, rideState.report);

  createNotificationsForUsers(
    [rideState.patientUserId, ...getDoctorIds(), ...getLinkedFamilyIds(rideState.patientUserId)],
    "ride_summary",
    "骑行报告已生成",
    `${rideState.user.name} 的本次骑行已结束，安全评分 ${rideState.report.safetyScore} 分。`,
    rideState.id,
  );

  sendRideReportEmails(rideState).catch((error) => {
    console.error(`Report email dispatch failed for ride ${rideState.id}: ${error.message}`);
  });

  broadcastRide(rideState, {
    type: "ride_finished",
    ride: serializeRideState(rideState),
  });

  activeRides.delete(rideState.id);
  return rideState;
}

function findActiveRideByPatient(patientUserId) {
  return [...activeRides.values()].find((ride) => ride.patientUserId === patientUserId && ride.status === "active");
}

function createRideState(patientUser, patientProfile, scenario, startLocation = null) {
  const rideId = makeId("ride");
  const createdAt = nowIso();

  db.prepare(`
    INSERT INTO ride_sessions (
      id, patient_user_id, scenario_id, scenario_name, status, started_at, latest_tick, total_risk_events, avg_risk_score, created_at,
      start_lat, start_lng, start_accuracy
    ) VALUES (?, ?, ?, ?, 'active', ?, 0, 0, 0, ?, ?, ?, ?)
  `).run(
    rideId,
    patientUser.id,
    scenario.id,
    scenario.name,
    createdAt,
    createdAt,
    startLocation?.lat ?? null,
    startLocation?.lng ?? null,
    startLocation?.accuracy ?? null,
  );

  const rideState = {
    id: rideId,
    patientUserId: patientUser.id,
    user: serializeUser(patientUser),
    profile: patientProfile,
    scenario,
    startLocation,
    status: "active",
    tick: 0,
    startedAt: createdAt,
    endedAt: null,
    currentState: {
      tick: 0,
      timestamp: createdAt,
      targets: [],
      risk: {
        level: "safe",
        score: 0,
        reason: "会话已启动，正在等待后方目标。",
        ttc: null,
        primaryTarget: null,
        alertMode: "idle",
      },
      deviceState: buildDeviceState(0, { level: "safe" }),
    },
    events: [],
    timeline: [],
    clients: new Set(),
    interval: null,
    report: null,
    riskScoreTotal: 0,
    riskSamples: 0,
  };

  activeRides.set(rideId, rideState);
  rideState.interval = setInterval(() => advanceRide(rideState), 1200);
  return rideState;
}

function canAccessRide(user, rideSummary) {
  if (!user || !rideSummary) {
    return false;
  }
  if (user.role === "doctor") {
    return true;
  }
  if (user.role === "patient") {
    return rideSummary.patientUserId === user.id;
  }
  if (user.role === "family") {
    const linked = db
      .prepare("SELECT 1 FROM family_links WHERE family_user_id = ? AND patient_user_id = ?")
      .get(user.id, rideSummary.patientUserId);
    return Boolean(linked);
  }
  return false;
}

function getDoctorPatientList() {
  const rows = db
    .prepare(
      `
      SELECT
        u.id,
        u.name,
        u.email,
        pp.condition_type,
        pp.rehab_stage,
        pp.patient_status,
        pp.doctor_threshold_adjustment
      FROM users u
      JOIN patient_profiles pp ON pp.user_id = u.id
      WHERE u.role = 'patient'
      ORDER BY u.created_at DESC
    `,
    )
    .all();

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    email: row.email,
    conditionType: row.condition_type,
    rehabStage: row.rehab_stage,
    patientStatus: row.patient_status,
    doctorThresholdAdjustment: row.doctor_threshold_adjustment,
    latestReport: getLatestReportByPatient(row.id),
    activeRide: findActiveRideByPatient(row.id) ? serializeRideState(findActiveRideByPatient(row.id)) : null,
  }));
}

function getFamilyDashboard(familyUserId) {
  const linkedPatients = db
    .prepare(
      `
      SELECT u.id, u.name, u.email
      FROM family_links fl
      JOIN users u ON u.id = fl.patient_user_id
      WHERE fl.family_user_id = ?
      ORDER BY fl.created_at DESC
    `,
    )
    .all(familyUserId)
    .map((row) => {
      const profile = getPatientProfile(row.id);
      return {
        id: row.id,
        name: row.name,
        email: row.email,
        profile,
        latestReport: getLatestReportByPatient(row.id),
        activeRide: findActiveRideByPatient(row.id) ? serializeRideState(findActiveRideByPatient(row.id)) : null,
      };
    });

  return linkedPatients;
}

function seedDemoDoctor() {
  const exists = db.prepare("SELECT id FROM users WHERE role = 'doctor' LIMIT 1").get();
  if (exists) {
    return;
  }
  db.prepare(`
    INSERT INTO users (name, email, password_hash, role, created_at)
    VALUES (?, ?, ?, 'doctor', ?)
  `).run("演示医生", "doctor@demo.com", bcrypt.hashSync("demo1234", 10), nowIso());
}

initDatabase();
seedDemoDoctor();

app.get("/api/reference-data", (_req, res) => {
  res.json({
    referenceProfiles,
    scenarios,
    patientStatuses,
    mapProvider: {
      type: "amap",
      webKey: process.env.AMAP_WEB_KEY || null,
      enabled: Boolean(process.env.AMAP_WEB_KEY),
    },
  });
});

app.get("/api/auth/me", (req, res) => {
  const token = getRequestToken(req);
  const user = getUserFromToken(token);
  if (!user) {
    res.json({ user: null });
    return;
  }
  res.json(buildAuthResponse(user.id, token));
});

app.post("/api/auth/register", (req, res) => {
  const {
    name,
    email,
    password,
    role,
    templateProfileId,
    age,
    gender,
  } = req.body;

  if (!name || !email || !password || !role) {
    res.status(400).json({ error: "缺少必要字段。" });
    return;
  }

  if (!["patient", "doctor", "family"].includes(role)) {
    res.status(400).json({ error: "角色非法。" });
    return;
  }

  const normalizedEmail = email.trim().toLowerCase();
  if (getUserByEmail(normalizedEmail)) {
    res.status(400).json({ error: "该邮箱已注册。" });
    return;
  }

  const createdAt = nowIso();
  const passwordHash = bcrypt.hashSync(password, 10);

  const transaction = db.transaction(() => {
    const userResult = db.prepare(`
      INSERT INTO users (name, email, password_hash, role, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(name.trim(), normalizedEmail, passwordHash, role, createdAt);

    if (role === "patient") {
      const template = getReferenceProfile(templateProfileId || "rehab_cardiac");
      if (!template) {
        throw new Error("无效的康复模板。");
      }
      db.prepare(`
        INSERT INTO patient_profiles (
          user_id, template_profile_id, age, gender, condition_type, rehab_stage,
          risk_sensitivity, recommended_duration, max_safe_heart_rate,
          doctor_threshold_adjustment, patient_status, status_updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1.0, '适合继续户外骑行', ?)
      `).run(
        userResult.lastInsertRowid,
        template.id,
        age || null,
        gender || null,
        template.conditionType,
        template.rehabStage,
        template.sensitivity,
        template.recommendedDuration,
        template.maxSafeHeartRate,
        createdAt,
      );
    }

    return userResult.lastInsertRowid;
  });

  try {
    const userId = transaction();
    const token = createAccessToken(userId);
    res.status(201).json(buildAuthResponse(userId, token));
  } catch (error) {
    res.status(400).json({ error: error.message || "注册失败。" });
  }
});

app.post("/api/auth/login", (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    res.status(400).json({ error: "请输入邮箱和密码。" });
    return;
  }

  const user = getUserByEmail(email);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    res.status(400).json({ error: "邮箱或密码错误。" });
    return;
  }

  const token = createAccessToken(user.id);
  res.json(buildAuthResponse(user.id, token));
});

app.post("/api/auth/logout", requireAuth, (req, res) => {
  revokeToken(req.accessToken);
  res.json({ ok: true });
});

app.get("/api/notifications", requireAuth, (req, res) => {
  res.json({ notifications: getNotificationsForUser(req.user.id) });
});

app.post("/api/notifications/:id/read", requireAuth, (req, res) => {
  db.prepare("UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?").run(req.params.id, req.user.id);
  res.json({ notifications: getNotificationsForUser(req.user.id) });
});

app.get("/api/patient/dashboard", requireAuth, requireRole(["patient"]), (req, res) => {
  const profile = getPatientProfile(req.user.id);
  const activeRide = findActiveRideByPatient(req.user.id);

  res.json({
    user: serializeUser(req.user),
    patientProfile: profile,
    scenarios,
    activeRide: activeRide ? serializeRideState(activeRide) : null,
    recentRides: getRecentRidesForPatient(req.user.id),
    notifications: getNotificationsForUser(req.user.id),
  });
});

app.post("/api/patient/rides/start", requireAuth, requireRole(["patient"]), (req, res) => {
  const { scenarioId, startLocation } = req.body;
  const scenario = getScenario(scenarioId);
  if (!scenario) {
    res.status(400).json({ error: "无效的骑行场景。" });
    return;
  }

  const existingRide = findActiveRideByPatient(req.user.id);
  if (existingRide) {
    res.status(400).json({ error: "当前已有进行中的骑行会话。" });
    return;
  }

  const patientProfile = getPatientProfile(req.user.id);
  let normalizedStartLocation = null;
  if (startLocation) {
    const lat = Number(startLocation.lat);
    const lng = Number(startLocation.lng);
    const accuracy = Number(startLocation.accuracy || 0);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      res.status(400).json({ error: "定位信息无效。" });
      return;
    }
    normalizedStartLocation = {
      lat: round(lat, 6),
      lng: round(lng, 6),
      accuracy: Number.isFinite(accuracy) ? round(Math.max(accuracy, 0), 1) : null,
    };
  }

  const rideState = createRideState(req.user, patientProfile, scenario, normalizedStartLocation);
  res.status(201).json({ ride: serializeRideState(rideState) });
});

app.post("/api/patient/rides/:id/finish", requireAuth, requireRole(["patient"]), (req, res) => {
  const activeRide = activeRides.get(req.params.id);
  if (!activeRide || activeRide.patientUserId !== req.user.id) {
    res.status(404).json({ error: "骑行会话不存在。" });
    return;
  }
  finishRide(activeRide);
  res.json({ ride: getRideSummary(req.params.id) });
});

app.get("/api/rides/:id", requireAuth, (req, res) => {
  const activeRide = activeRides.get(req.params.id);
  if (activeRide) {
    const ride = serializeRideState(activeRide);
    if (!canAccessRide(req.user, { patientUserId: activeRide.patientUserId })) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    res.json({ ride });
    return;
  }

  const rideSummary = getRideSummary(req.params.id);
  if (!rideSummary) {
    res.status(404).json({ error: "骑行会话不存在。" });
    return;
  }
  if (!canAccessRide(req.user, rideSummary)) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  res.json({ ride: rideSummary });
});

app.get("/api/rides/:id/report", requireAuth, (req, res) => {
  const rideSummary = getRideSummary(req.params.id);
  if (!rideSummary) {
    res.status(404).json({ error: "骑行报告不存在。" });
    return;
  }
  if (!canAccessRide(req.user, rideSummary)) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  res.json({ ride: rideSummary });
});

app.get("/api/rides/:id/emails", requireAuth, (req, res) => {
  const rideSummary = getRideSummary(req.params.id);
  if (!rideSummary) {
    res.status(404).json({ error: "骑行会话不存在。" });
    return;
  }
  if (!canAccessRide(req.user, rideSummary)) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  res.json({
    emailDeliveries: getEmailDeliveriesForSession(req.params.id),
    emailEnabled: isEmailEnabled(),
  });
});

app.get("/api/rides/:id/stream", requireAuth, (req, res) => {
  const activeRide = activeRides.get(req.params.id);
  if (!activeRide || !canAccessRide(req.user, { patientUserId: activeRide.patientUserId })) {
    res.status(404).end();
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  activeRide.clients.add(res);
  res.write(`data: ${JSON.stringify({ type: "connected", ride: serializeRideState(activeRide) })}\n\n`);

  req.on("close", () => {
    activeRide.clients.delete(res);
  });
});

app.get("/api/doctor/dashboard", requireAuth, requireRole(["doctor"]), (req, res) => {
  res.json({
    user: serializeUser(req.user),
    patients: getDoctorPatientList(),
    notifications: getNotificationsForUser(req.user.id),
    patientStatuses,
  });
});

app.get("/api/doctor/patients/:id", requireAuth, requireRole(["doctor"]), (req, res) => {
  const patient = getUserById(req.params.id);
  if (!patient || patient.role !== "patient") {
    res.status(404).json({ error: "患者不存在。" });
    return;
  }
  const doctorActions = db
    .prepare(
      `
      SELECT action_type, payload_json, created_at
      FROM doctor_actions
      WHERE patient_user_id = ?
      ORDER BY created_at DESC
      LIMIT 10
    `,
    )
    .all(patient.id)
    .map((row) => ({
      actionType: row.action_type,
      payload: parseJson(row.payload_json, {}),
      createdAt: row.created_at,
    }));

  res.json({
    patient: serializeUser(patient),
    profile: getPatientProfile(patient.id),
    recentRides: getRecentRidesForPatient(patient.id),
    latestReport: getLatestReportByPatient(patient.id),
    activeRide: findActiveRideByPatient(patient.id) ? serializeRideState(findActiveRideByPatient(patient.id)) : null,
    doctorActions,
  });
});

app.post("/api/doctor/patients/:id/threshold", requireAuth, requireRole(["doctor"]), (req, res) => {
  const patient = getUserById(req.params.id);
  if (!patient || patient.role !== "patient") {
    res.status(404).json({ error: "患者不存在。" });
    return;
  }

  const adjustment = Number(req.body.adjustment);
  if (!Number.isFinite(adjustment) || adjustment < 0.7 || adjustment > 1.8) {
    res.status(400).json({ error: "阈值调整系数应在 0.7 到 1.8 之间。" });
    return;
  }

  db.prepare(`
    UPDATE patient_profiles
    SET doctor_threshold_adjustment = ?, status_updated_at = ?
    WHERE user_id = ?
  `).run(adjustment, nowIso(), patient.id);

  db.prepare(`
    INSERT INTO doctor_actions (doctor_user_id, patient_user_id, action_type, payload_json, created_at)
    VALUES (?, ?, 'threshold_adjustment', ?, ?)
  `).run(req.user.id, patient.id, JSON.stringify({ adjustment }), nowIso());

  createNotificationsForUsers(
    [patient.id],
    "doctor_action",
    "医生调整了预警阈值",
    `医生已将你的预警敏感度调整为 ${adjustment} 倍。`,
    null,
  );

  res.json({
    profile: getPatientProfile(patient.id),
  });
});

app.post("/api/doctor/patients/:id/status", requireAuth, requireRole(["doctor"]), (req, res) => {
  const patient = getUserById(req.params.id);
  if (!patient || patient.role !== "patient") {
    res.status(404).json({ error: "患者不存在。" });
    return;
  }

  const { status } = req.body;
  if (!patientStatuses.includes(status)) {
    res.status(400).json({ error: "无效的患者状态。" });
    return;
  }

  db.prepare(`
    UPDATE patient_profiles
    SET patient_status = ?, status_updated_at = ?
    WHERE user_id = ?
  `).run(status, nowIso(), patient.id);

  db.prepare(`
    INSERT INTO doctor_actions (doctor_user_id, patient_user_id, action_type, payload_json, created_at)
    VALUES (?, ?, 'patient_status', ?, ?)
  `).run(req.user.id, patient.id, JSON.stringify({ status }), nowIso());

  createNotificationsForUsers(
    [patient.id, ...getLinkedFamilyIds(patient.id)],
    "doctor_action",
    "医生更新了患者状态",
    `${patient.name} 的骑行建议已更新为：${status}。`,
    null,
  );

  res.json({
    profile: getPatientProfile(patient.id),
  });
});

app.get("/api/family/dashboard", requireAuth, requireRole(["family"]), (req, res) => {
  res.json({
    user: serializeUser(req.user),
    linkedPatients: getFamilyDashboard(req.user.id),
    notifications: getNotificationsForUser(req.user.id),
  });
});

app.post("/api/family/link", requireAuth, requireRole(["family"]), (req, res) => {
  const { patientEmail } = req.body;
  if (!patientEmail) {
    res.status(400).json({ error: "请输入患者邮箱。" });
    return;
  }
  const patient = getUserByEmail(patientEmail);
  if (!patient || patient.role !== "patient") {
    res.status(404).json({ error: "未找到对应患者。" });
    return;
  }

  db.prepare(`
    INSERT INTO family_links (family_user_id, patient_user_id, created_at)
    VALUES (?, ?, ?)
    ON CONFLICT(family_user_id, patient_user_id) DO NOTHING
  `).run(req.user.id, patient.id, nowIso());

  createNotificationsForUsers(
    [patient.id],
    "family_link",
    "家属已关联你的账号",
    `家属账号 ${req.user.name} 已成功关注你的骑行安全。`,
    null,
  );

  res.json({
    linkedPatients: getFamilyDashboard(req.user.id),
  });
});

app.use((_req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Demo server running on http://localhost:${PORT}`);
});
