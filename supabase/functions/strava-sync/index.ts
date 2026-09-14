import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "https://deejaytriiad-run.github.io",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Méthode non autorisée" }, 405);

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "Connexion RunFlow requise" }, 401);

    const url = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const clientId = Deno.env.get("STRAVA_CLIENT_ID")!;
    const clientSecret = Deno.env.get("STRAVA_CLIENT_SECRET")!;

    const userClient = createClient(url, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: userError } = await userClient.auth.getUser();
    if (userError || !user) return json({ error: "Session RunFlow invalide" }, 401);

    const admin = createClient(url, serviceKey);
    const body = await req.json();
    const action = body.action;

    if (action === "exchange") {
      if (!body.code || !body.redirectUri) return json({ error: "Code OAuth manquant" }, 400);
      const params = new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code: body.code,
        grant_type: "authorization_code",
      });
      const tokenRes = await fetch("https://www.strava.com/oauth/token", { method: "POST", body: params });
      const token = await tokenRes.json();
      if (!tokenRes.ok) return json({ error: token.message || "Autorisation Strava refusée" }, 400);

      const { error } = await admin.from("strava_connections").upsert({
        user_id: user.id,
        athlete_id: token.athlete.id,
        access_token: token.access_token,
        refresh_token: token.refresh_token,
        expires_at: token.expires_at,
        athlete_data: token.athlete,
        updated_at: new Date().toISOString(),
      });
      if (error) throw error;
    } else if (action !== "sync") {
      return json({ error: "Action inconnue" }, 400);
    }

    const { data: connection, error: connectionError } = await admin
      .from("strava_connections").select("*").eq("user_id", user.id).single();
    if (connectionError || !connection) return json({ error: "Compte Strava non connecté" }, 404);

    let accessToken = connection.access_token;
    let refreshToken = connection.refresh_token;
    let expiresAt = connection.expires_at;

    if (expiresAt <= Math.floor(Date.now() / 1000) + 300) {
      const refreshParams = new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      });
      const refreshRes = await fetch("https://www.strava.com/oauth/token", {
        method: "POST", body: refreshParams,
      });
      const refreshed = await refreshRes.json();
      if (!refreshRes.ok) return json({ error: refreshed.message || "Token Strava expiré" }, 401);
      accessToken = refreshed.access_token;
      refreshToken = refreshed.refresh_token;
      expiresAt = refreshed.expires_at;
      await admin.from("strava_connections").update({
        access_token: accessToken,
        refresh_token: refreshToken,
        expires_at: expiresAt,
        updated_at: new Date().toISOString(),
      }).eq("user_id", user.id);
    }

    let page = 1;
    let imported = 0;
    while (page <= 100) {
      const activitiesRes = await fetch(
        `https://www.strava.com/api/v3/athlete/activities?per_page=100&page=${page}`,
        { headers: { Authorization: `Bearer ${accessToken}` } },
      );
      if (!activitiesRes.ok) return json({ error: "Lecture Strava impossible" }, activitiesRes.status);
      const activities = await activitiesRes.json();
      if (!activities.length) break;

      const runs = activities
        .filter((a: any) => ["Run", "TrailRun", "VirtualRun"].includes(a.sport_type || a.type))
        .map((a: any) => ({
          user_id: user.id,
          name: a.name || "Course Strava",
          run_date: a.start_date_local.slice(0, 10),
          distance_km: Math.round((a.distance / 1000) * 100) / 100,
          duration_minutes: Math.max(1, Math.round(a.moving_time / 60)),
          notes: "",
          source: "Strava",
          external_id: String(a.id),
        }));

      if (runs.length) {
        const { error } = await admin.from("runs")
          .upsert(runs, { onConflict: "user_id,source,external_id" });
        if (error) throw error;
        imported += runs.length;
      }
      if (activities.length < 100) break;
      page++;
    }

    return json({ success: true, imported });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Erreur inconnue" }, 500);
  }
});
