const fs = require("fs");

// ==========================================
// 1. UPDATE server.ts /api/admin/dashboard
// ==========================================
let serverTs = fs.readFileSync("server.ts", "utf8");

const oldDashboardRegex = /\/\/ 15\. ADMIN COMPREHENSIVE DASHBOARD OVERVIEW \(ALL REAL METRICS\)[\s\S]*?return res\.json\(\{\s*metrics: \{[\s\S]*?\}\s*\}\);\s*\}\);/;

const newDashboardTS = `// 15. ADMIN COMPREHENSIVE DASHBOARD OVERVIEW (REAL LIVE NEON DB METRICS)
app.get('/api/admin/dashboard', async (_req: Request, res: Response) => {
  let totalUsers = 0;
  let connectedUsers = 0;
  let automationEnabledUsers = 0;
  let autoReplyUsers = 0;
  let libraryOwnersCount = 0;
  let businessUsersCount = 0;

  if (isDbConnected()) {
    const pool = getPool();
    if (pool) {
      try {
        const rTotal = await pool.query("SELECT COUNT(*) FROM users WHERE LOWER(username) != 'admin'");
        const rConn = await pool.query("SELECT COUNT(*) FROM users WHERE status = 'Connected' AND wa_jid != '' AND LOWER(username) != 'admin'");
        const rAutoAcc = await pool.query("SELECT COUNT(*) FROM users WHERE automation_access = true AND LOWER(username) != 'admin'");
        const rAutoRep = await pool.query("SELECT COUNT(*) FROM users WHERE auto_reply = true AND LOWER(username) != 'admin'");
        const rLib = await pool.query("SELECT COUNT(*) FROM users WHERE user_type = 'library_owner' AND LOWER(username) != 'admin'");
        const rBiz = await pool.query("SELECT COUNT(*) FROM users WHERE user_type = 'business_user' AND LOWER(username) != 'admin'");

        totalUsers = parseInt(rTotal.rows[0].count, 10) || 0;
        connectedUsers = parseInt(rConn.rows[0].count, 10) || 0;
        automationEnabledUsers = parseInt(rAutoAcc.rows[0].count, 10) || 0;
        autoReplyUsers = parseInt(rAutoRep.rows[0].count, 10) || 0;
        libraryOwnersCount = parseInt(rLib.rows[0].count, 10) || 0;
        businessUsersCount = parseInt(rBiz.rows[0].count, 10) || 0;

        // Sync RAM memoryUsers with Neon DB so stale deleted accounts are removed from RAM
        const allDbUsers = await pool.query("SELECT username, status, wa_jid FROM users");
        const validDbUsernames = new Set(allDbUsers.rows.map(r => r.username.toLowerCase()));

        for (const [uname] of memoryUsers.entries()) {
          if (!validDbUsernames.has(uname) && uname !== 'admin') {
            memoryUsers.delete(uname);
          }
        }

        for (const row of allDbUsers.rows) {
          const u = memoryUsers.get(row.username.toLowerCase());
          if (u) {
            u.status = row.status || 'Disconnected';
            u.wa_jid = row.wa_jid || '';
          }
        }
      } catch (err: any) {
        console.error('Failed to fetch dashboard metrics from Neon DB:', err.message);
      }
    }
  } else {
    const users = Array.from(memoryUsers.values()).filter(u => u.username !== 'admin');
    totalUsers = users.length;
    connectedUsers = users.filter(u => u.status === 'Connected' && Boolean(u.wa_jid)).length;
    automationEnabledUsers = users.filter(u => u.automation_access).length;
    autoReplyUsers = users.filter(u => u.auto_reply).length;
    libraryOwnersCount = users.filter(u => u.user_type === 'library_owner').length;
    businessUsersCount = users.filter(u => u.user_type === 'business_user').length;
  }

  return res.json({
    metrics: {
      totalUsers,
      libraryOwnersCount,
      businessUsersCount,
      connectedUsers,
      disconnectedUsers: totalUsers - connectedUsers,
      automationEnabledUsers,
      autoReplyUsers,
      totalMessagesSent: stats.totalMessagesSent,
      totalAiReplies: stats.totalAiReplies,
      campaignsLaunched: stats.campaignsLaunched
    }
  });
});`;

if (oldDashboardRegex.test(serverTs)) {
  serverTs = serverTs.replace(oldDashboardRegex, newDashboardTS);
  fs.writeFileSync("server.ts", serverTs, "utf8");
  console.log("Updated server.ts /api/admin/dashboard to query Neon DB directly!");
} else {
  console.error("Could not match old dashboard handler in server.ts!");
}

// ==========================================
// 2. UPDATE api/admin.go AdminDashboardHandler
// ==========================================
let adminGo = fs.readFileSync("api/admin.go", "utf8");

const oldAdminGoDashRegex = /\/\/ ADMIN COMPREHENSIVE DASHBOARD OVERVIEW[\s\S]*?respondJSON\(w, 200, map\[string\]interface\{\}[\s\S]*?\}\)/;

const newAdminGoDash = `// ADMIN COMPREHENSIVE DASHBOARD OVERVIEW
func AdminDashboardHandler(w http.ResponseWriter, r *http.Request) {
	totalUsers := 0
	connectedUsers := 0
	automationEnabled := 0
	autoReplyUsers := 0
	libraryOwners := 0
	businessUsers := 0

	if DB != nil {
		_ = DB.QueryRow("SELECT COUNT(*) FROM users WHERE LOWER(username) != 'admin'").Scan(&totalUsers)
		_ = DB.QueryRow("SELECT COUNT(*) FROM users WHERE status='Connected' AND wa_jid != '' AND LOWER(username) != 'admin'").Scan(&connectedUsers)
		_ = DB.QueryRow("SELECT COUNT(*) FROM users WHERE automation_access=true AND LOWER(username) != 'admin'").Scan(&automationEnabled)
		_ = DB.QueryRow("SELECT COUNT(*) FROM users WHERE auto_reply=true AND LOWER(username) != 'admin'").Scan(&autoReplyUsers)
		_ = DB.QueryRow("SELECT COUNT(*) FROM users WHERE user_type='library_owner' AND LOWER(username) != 'admin'").Scan(&libraryOwners)
		_ = DB.QueryRow("SELECT COUNT(*) FROM users WHERE user_type='business_user' AND LOWER(username) != 'admin'").Scan(&businessUsers)
	}

	respondJSON(w, 200, map[string]interface{}{
		"status": "success",
		"metrics": map[string]interface{}{
			"totalUsers":              totalUsers,
			"connectedUsers":          connectedUsers,
			"disconnectedUsers":       totalUsers - connectedUsers,
			"automationEnabledUsers":  automationEnabled,
			"autoReplyUsers":          autoReplyUsers,
			"libraryOwnersCount":      libraryOwners,
			"businessUsersCount":      businessUsers,
		},
	})
}`;

if (oldAdminGoDashRegex.test(adminGo)) {
  adminGo = adminGo.replace(oldAdminGoDashRegex, newAdminGoDash);
  fs.writeFileSync("api/admin.go", adminGo, "utf8");
  console.log("Updated api/admin.go AdminDashboardHandler to query Neon DB with strict filters!");
} else {
  console.error("Could not match old AdminDashboardHandler in api/admin.go!");
}

console.log("All Admin Overview & Health Metrics patches applied successfully!");
