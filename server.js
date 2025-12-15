import express from "express";
import cors from "cors";
import pg from "pg";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json({ limit: "10mb" }));

// CORS: set APP_ORIGIN to your GoodBarber/web domain later.
// For MVP, you can leave APP_ORIGIN blank and allow all.
const allowedOrigin = process.env.APP_ORIGIN || "*";
app.use(
  cors({
    origin: allowedOrigin === "*" ? true : allowedOrigin,
    credentials: true
  })
);

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

function requireEmail(req, res, next) {
  const email = (req.header("X-User-Email") || "").trim().toLowerCase();
  const name = (req.header("X-User-Name") || "").trim();

  if (!email) {
    return res.status(401).json({
      error: "Missing identity header X-User-Email"
    });
  }
  req.identity = { email, name };
  next();
}

async function getOrCreateUser(client, { email, name }) {
  // Create user if missing; update display_name if provided
  const existing = await client.query(
    `SELECT id, email, display_name FROM users WHERE email=$1`,
    [email]
  );
  if (existing.rowCount > 0) {
    const u = existing.rows[0];
    if (name && (!u.display_name || u.display_name !== name)) {
      await client.query(`UPDATE users SET display_name=$1, last_login_at=now() WHERE id=$2`, [name, u.id]);
    } else {
      await client.query(`UPDATE users SET last_login_at=now() WHERE id=$1`, [u.id]);
    }
    return { id: u.id, email: u.email };
  }

  const created = await client.query(
    `INSERT INTO users (email, display_name, last_login_at)
     VALUES ($1, $2, now())
     RETURNING id, email`,
    [email, name || null]
  );

  // Give them a default "free" subscription row (optional but handy)
  await client.query(
    `INSERT INTO subscriptions (user_id, provider, plan, status)
     VALUES ($1, 'internal', 'free', 'active')
     ON CONFLICT DO NOTHING`,
    [created.rows[0].id]
  );

  return created.rows[0];
}

async function requireTripAccess(client, tripId, userId) {
  const m = await client.query(
    `SELECT role, status
       FROM trip_members
      WHERE trip_id=$1 AND user_id=$2 AND status='active'`,
    [tripId, userId]
  );
  return m.rowCount > 0 ? m.rows[0] : null;
}

// --- Health ---
app.get("/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// --- Identity ---
app.get("/api/me", requireEmail, async (req, res) => {
  const client = await pool.connect();
  try {
    const user = await getOrCreateUser(client, req.identity);
    res.json({ userId: user.id, email: user.email });
  } finally {
    client.release();
  }
});

// --- Trips ---
app.get("/api/trips", requireEmail, async (req, res) => {
  const client = await pool.connect();
  try {
    const user = await getOrCreateUser(client, req.identity);

    const result = await client.query(
      `SELECT t.id,
              t.title,
              to_char(t.start_date,'YYYY-MM-DD') AS "startDate",
              to_char(t.end_date,'YYYY-MM-DD') AS "endDate",
              COALESCE(m.cdn_url, m.thumb_url) AS "coverUrl"
         FROM trips t
         JOIN trip_members tm ON tm.trip_id=t.id
         LEFT JOIN media m ON m.id=t.cover_media_id
        WHERE tm.user_id=$1 AND tm.status='active'
        ORDER BY t.created_at DESC`,
      [user.id]
    );

    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

app.post("/api/trips", requireEmail, async (req, res) => {
  const { title, startDate, endDate, timezone } = req.body || {};
  if (!title) return res.status(400).json({ error: "title is required" });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const user = await getOrCreateUser(client, req.identity);

    const trip = await client.query(
      `INSERT INTO trips (owner_user_id, title, start_date, end_date, timezone)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, title, start_date, end_date, timezone`,
      [
        user.id,
        title,
        startDate || null,
        endDate || null,
        timezone || "America/New_York"
      ]
    );

    await client.query(
      `INSERT INTO trip_members (trip_id, user_id, role, status)
       VALUES ($1, $2, 'owner', 'active')
       ON CONFLICT DO NOTHING`,
      [trip.rows[0].id, user.id]
    );

    await client.query("COMMIT");
    res.status(201).json({
      id: trip.rows[0].id,
      title: trip.rows[0].title,
      startDate: trip.rows[0].start_date ? trip.rows[0].start_date.toISOString().slice(0,10) : null,
      endDate: trip.rows[0].end_date ? trip.rows[0].end_date.toISOString().slice(0,10) : null,
      timezone: trip.rows[0].timezone
    });
  } catch (e) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

app.get("/api/trips/:tripId", requireEmail, async (req, res) => {
  const { tripId } = req.params;
  const client = await pool.connect();
  try {
    const user = await getOrCreateUser(client, req.identity);
    const access = await requireTripAccess(client, tripId, user.id);
    if (!access) return res.status(403).json({ error: "No access to trip" });

    const t = await client.query(
      `SELECT id,
              title,
              to_char(start_date,'YYYY-MM-DD') AS "startDate",
              to_char(end_date,'YYYY-MM-DD') AS "endDate",
              timezone
         FROM trips
        WHERE id=$1`,
      [tripId]
    );

    if (!t.rowCount) return res.status(404).json({ error: "Trip not found" });
    res.json(t.rows[0]);
  } finally {
    client.release();
  }
});

// --- Moments ---
app.get("/api/trips/:tripId/moments", requireEmail, async (req, res) => {
  const { tripId } = req.params;
  const client = await pool.connect();
  try {
    const user = await getOrCreateUser(client, req.identity);
    const access = await requireTripAccess(client, tripId, user.id);
    if (!access) return res.status(403).json({ error: "No access to trip" });

    const momentsRes = await client.query(
      `SELECT id,
              story,
              location_name AS "locationName",
              moment_time AS "momentTime",
              COALESCE(to_char(moment_time AT TIME ZONE 'UTC','YYYY-MM-DD'), to_char(created_at,'YYYY-MM-DD')) AS "dayKey"
         FROM moments
        WHERE trip_id=$1
        ORDER BY COALESCE(moment_time, created_at) ASC`,
      [tripId]
    );

    const momentIds = momentsRes.rows.map(r => r.id);

    let mediaByMoment = new Map();
    let attachByMoment = new Map();

    if (momentIds.length) {
      const mediaRes = await client.query(
        `SELECT id, moment_id, type,
                COALESCE(cdn_url, '') AS url,
                COALESCE(thumb_url, cdn_url, '') AS "thumbUrl",
                COALESCE(cdn_url, '') AS "streamUrl",
                sort_order
           FROM media
          WHERE moment_id = ANY($1::uuid[])
          ORDER BY moment_id, sort_order, created_at`,
        [momentIds]
      );
      for (const m of mediaRes.rows) {
        const arr = mediaByMoment.get(m.moment_id) || [];
        arr.push({
          id: m.id,
          type: m.type,
          url: m.url || null,
          thumbUrl: m.thumbUrl || null,
          streamUrl: m.streamUrl || null
        });
        mediaByMoment.set(m.moment_id, arr);
      }

      const attRes = await client.query(
        `SELECT id, moment_id, type,
                COALESCE(title, '') AS title,
                COALESCE(url, cdn_url, '') AS url
           FROM attachments
          WHERE moment_id = ANY($1::uuid[])
          ORDER BY moment_id, created_at`,
        [momentIds]
      );
      for (const a of attRes.rows) {
        const arr = attachByMoment.get(a.moment_id) || [];
        arr.push({
          id: a.id,
          type: a.type,
          title: a.title || null,
          url: a.url || null
        });
        attachByMoment.set(a.moment_id, arr);
      }
    }

    const payload = momentsRes.rows.map(m => ({
      id: m.id,
      story: m.story || "",
      locationName: m.locationName || "",
      momentTime: m.momentTime,
      dayKey: m.dayKey,
      media: mediaByMoment.get(m.id) || [],
      attachments: attachByMoment.get(m.id) || []
    }));

    res.json(payload);
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

app.post("/api/trips/:tripId/moments", requireEmail, async (req, res) => {
  const { tripId } = req.params;
  const { story, locationName, momentTime } = req.body || {};

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const user = await getOrCreateUser(client, req.identity);
    const access = await requireTripAccess(client, tripId, user.id);
    if (!access) return res.status(403).json({ error: "No access to trip" });

    const ins = await client.query(
      `INSERT INTO moments (trip_id, created_by_user_id, story, location_name, moment_time)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [tripId, user.id, story || null, locationName || null, momentTime || null]
    );

    await client.query("COMMIT");
    res.status(201).json({ id: ins.rows[0].id });
  } catch (e) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`API listening on ${port}`));