/**
 * WaMart Cloudflare Worker - Cloudflare R2 Native Media Proxy & Upload Engine
 * 
 * Handles:
 * 1. OPTIONS: Instant CORS preflight response
 * 2. POST /upload?path=[tenant_slug]/[folder]/[uuid].[ext]:
 *    Accepts raw binary stream from frontend, uploads directly to Cloudflare R2 (MY_BUCKET binding),
 *    and returns JSON { "success": true, "url": "https://wamart-cloudflare.rkmtech633.workers.dev/[path]", "path": "[path]" }
 * 3. GET /[path]:
 *    Streams public R2 bucket media with high-speed CDN edge caching
 * 4. DELETE /delete?path=...:
 *    Deletes a single file key directly from R2 bucket
 * 5. DELETE /delete-folder?prefix=...:
 *    Deletes all files under the specified folder prefix from R2 bucket
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 1. CORS Preflight Handling
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, x-amz-date, x-amz-content-sha256",
      "Access-Control-Max-Age": "86400",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders,
      });
    }

    // Health check
    if (url.pathname === "/" && request.method === "GET") {
      return new Response("WaMart Cloudflare R2 Media Proxy Active", {
        headers: { ...corsHeaders, "Content-Type": "text/plain" },
      });
    }

    // 2. Upload Endpoint: POST /upload?path=...
    if (url.pathname === "/upload" && request.method === "POST") {
      const uploadPath = url.searchParams.get("path");
      if (!uploadPath) {
        return new Response(JSON.stringify({ success: false, error: "Missing 'path' query parameter" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const cleanPath = uploadPath.replace(/^\/+/, "");
      try {
        const fileBytes = await request.arrayBuffer();
        const contentType = request.headers.get("content-type") || "image/jpeg";

        if (env.MY_BUCKET) {
          await env.MY_BUCKET.put(cleanPath, fileBytes, {
            httpMetadata: { contentType: contentType }
          });
        }

        const publicUrl = `https://wamart-cloudflare.rkmtech633.workers.dev/${cleanPath}`;
        return new Response(JSON.stringify({
          success: true,
          url: publicUrl,
          path: cleanPath,
        }), {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      } catch (err) {
        return new Response(JSON.stringify({ success: false, error: err.message || String(err) }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    // 3. Delete Single File Endpoint: DELETE /delete?path=...
    if ((url.pathname === "/delete" || url.pathname === "/api/delete") && (request.method === "DELETE" || request.method === "POST")) {
      const deletePath = url.searchParams.get("path");
      if (!deletePath) {
        return new Response(JSON.stringify({ success: false, error: "Missing 'path' query parameter" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const cleanPath = deletePath.replace(/^\/+/, "");
      try {
        if (env.MY_BUCKET) {
          await env.MY_BUCKET.delete(cleanPath);
        }

        return new Response(JSON.stringify({
          success: true,
          message: `File '${cleanPath}' deleted successfully from R2`,
        }), {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      } catch (err) {
        return new Response(JSON.stringify({ success: false, error: err.message || String(err) }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    // 4. Delete Folder Prefix Endpoint: DELETE /delete-folder?prefix=... (also accepts /delete-prefix)
    if ((url.pathname === "/delete-folder" || url.pathname === "/delete-prefix") && (request.method === "DELETE" || request.method === "POST")) {
      const prefix = url.searchParams.get("prefix") || "";
      const cleanPrefix = prefix.replace(/^\/+/, "");

      try {
        let deletedCount = 0;
        if (env.MY_BUCKET && cleanPrefix) {
          const objects = await env.MY_BUCKET.list({ prefix: cleanPrefix });
          for (const obj of objects.objects) {
            await env.MY_BUCKET.delete(obj.key);
            deletedCount++;
          }
        }

        return new Response(JSON.stringify({
          success: true,
          message: `Deleted ${deletedCount} files for prefix: ${cleanPrefix}`,
        }), {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      } catch (err) {
        return new Response(JSON.stringify({ success: false, error: err.message || String(err) }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    // 5. Media Fetch Proxy: GET /[path]
    if (request.method === "GET") {
      const cleanPath = url.pathname.replace(/^\/+/, "");
      if (!cleanPath) {
        return new Response("Not found", { status: 404, headers: corsHeaders });
      }

      try {
        if (env.MY_BUCKET) {
          const object = await env.MY_BUCKET.get(cleanPath);
          if (!object) {
            return new Response("Media Object Not Found", { status: 404, headers: corsHeaders });
          }

          const headers = new Headers();
          Object.entries(corsHeaders).forEach(([k, v]) => headers.set(k, v));
          object.writeHttpMetadata(headers);
          headers.set("etag", object.httpEtag);
          headers.set("Cache-Control", "public, max-age=31536000, immutable");

          return new Response(object.body, { headers });
        }

        return new Response("R2 Bucket Binding Pending", { status: 200, headers: corsHeaders });
      } catch (err) {
        return new Response("R2 fetch error: " + (err.message || String(err)), {
          status: 502,
          headers: corsHeaders,
        });
      }
    }

    return new Response("Method not allowed", { status: 405, headers: corsHeaders });
  }
};

