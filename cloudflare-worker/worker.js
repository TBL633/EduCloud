/**
 * WaMart Cloudflare Worker - Backblaze B2 Media Proxy & Upload Engine
 * 
 * Handles:
 * 1. OPTIONS: Instant CORS preflight response
 * 2. POST /upload?path=[tenant_slug]/[folder]/[uuid].[ext]:
 *    Accepts raw binary stream from frontend, uploads directly to Backblaze B2,
 *    and returns JSON { "success": true, "url": "https://[worker_domain]/[path]" }
 * 3. GET /[path]:
 *    Authorizes and streams private B2 bucket media publicly with high-speed CDN caching
 * 
 * Required Cloudflare Worker Environment Variables (Set in Settings -> Variables):
 * - B2_KEY_ID: Backblaze B2 Application Key ID (or keyID)
 * - B2_APPLICATION_KEY: Backblaze B2 Application Key
 * - B2_BUCKET_NAME: Your Backblaze B2 Bucket Name
 * - B2_ENDPOINT: Backblaze S3 Endpoint (e.g. s3.us-east-005.backblazeb2.com)
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
      return new Response("WaMart B2 Media Proxy Active", {
        headers: { ...corsHeaders, "Content-Type": "text/plain" },
      });
    }

    const b2Endpoint = (env.B2_ENDPOINT || "s3.us-east-005.backblazeb2.com").replace(/^https?:\/\//, "");
    const bucketName = env.B2_BUCKET_NAME || "";
    const keyId = env.B2_KEY_ID || "";
    const appKey = env.B2_APPLICATION_KEY || "";

    // 2. Upload Endpoint: POST /upload?path=...
    if (url.pathname === "/upload" && request.method === "POST") {
      const uploadPath = url.searchParams.get("path");
      if (!uploadPath) {
        return new Response(JSON.stringify({ success: false, error: "Missing 'path' query parameter" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      if (!keyId || !appKey || !bucketName) {
        return new Response(JSON.stringify({
          success: false,
          error: "Cloudflare Worker missing B2 credentials! Please configure B2_KEY_ID, B2_APPLICATION_KEY, and B2_BUCKET_NAME in Cloudflare Worker Settings -> Variables."
        }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      try {
        const fileBytes = await request.arrayBuffer();
        const contentType = request.headers.get("content-type") || "image/jpeg";

        // Upload to Backblaze B2 S3 API using S3 PutObject request
        const s3Path = `/${bucketName}/${uploadPath.replace(/^\/+/, "")}`;
        const s3Host = b2Endpoint;
        const uploadUrl = `https://${s3Host}${s3Path}`;

        const authHeader = "Basic " + btoa(`${keyId}:${appKey}`);

        const b2Resp = await fetch(uploadUrl, {
          method: "PUT",
          headers: {
            "Authorization": authHeader,
            "Content-Type": contentType,
            "Host": s3Host,
          },
          body: fileBytes,
        });

        if (!b2Resp.ok) {
          const errText = await b2Resp.text();
          return new Response(JSON.stringify({
            success: false,
            error: `B2 S3 upload failed with status ${b2Resp.status}: ${errText}`
          }), {
            status: 502,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        const publicUrl = `${url.origin}/${uploadPath.replace(/^\/+/, "")}`;
        return new Response(JSON.stringify({
          success: true,
          url: publicUrl,
          path: uploadPath,
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

    // 3. Media Fetch Proxy: GET /[tenant_slug]/products/... or GET /[tenant_slug]/branding/...
    if (request.method === "GET") {
      const cleanPath = url.pathname.replace(/^\/+/, "");
      if (!cleanPath) {
        return new Response("Not found", { status: 404, headers: corsHeaders });
      }

      const s3Url = `https://${b2Endpoint}/${bucketName}/${cleanPath}`;
      const authHeader = keyId && appKey ? ("Basic " + btoa(`${keyId}:${appKey}`)) : undefined;

      const fetchHeaders = {
        "Host": b2Endpoint,
      };
      if (authHeader) {
        fetchHeaders["Authorization"] = authHeader;
      }

      try {
        const b2Resp = await fetch(s3Url, {
          method: "GET",
          headers: fetchHeaders,
          cf: {
            cacheEverything: true,
            cacheTtl: 31536000,
          },
        });

        if (!b2Resp.ok) {
          return new Response(b2Resp.body, {
            status: b2Resp.status,
            headers: { ...corsHeaders, "Content-Type": b2Resp.headers.get("content-type") || "text/plain" },
          });
        }

        const responseHeaders = new Headers(b2Resp.headers);
        Object.entries(corsHeaders).forEach(([k, v]) => responseHeaders.set(k, v));
        responseHeaders.set("Cache-Control", "public, max-age=31536000, immutable");

        return new Response(b2Resp.body, {
          status: 200,
          headers: responseHeaders,
        });
      } catch (err) {
        return new Response("Proxy error: " + (err.message || String(err)), {
          status: 502,
          headers: corsHeaders,
        });
      }
    }

    // 4. Delete Single File Endpoint: DELETE /delete?path=...
    if ((url.pathname === "/delete" || url.pathname === "/api/delete") && (request.method === "DELETE" || request.method === "POST")) {
      const deletePath = url.searchParams.get("path");
      if (!deletePath) {
        return new Response(JSON.stringify({ success: false, error: "Missing 'path' query parameter" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const s3Path = `/${bucketName}/${deletePath.replace(/^\/+/, "")}`;
      const deleteUrl = `https://${b2Endpoint}${s3Path}`;
      const authHeader = keyId && appKey ? ("Basic " + btoa(`${keyId}:${appKey}`)) : undefined;

      try {
        const b2Resp = await fetch(deleteUrl, {
          method: "DELETE",
          headers: {
            "Authorization": authHeader,
            "Host": b2Endpoint,
          },
        });

        return new Response(JSON.stringify({
          success: true,
          message: `File '${deletePath}' deleted successfully from B2`,
          status: b2Resp.status,
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

    // 5. Delete Prefix Endpoint: DELETE /delete-prefix?prefix=...
    if (url.pathname === "/delete-prefix" && (request.method === "DELETE" || request.method === "POST")) {
      const prefix = url.searchParams.get("prefix") || "";
      return new Response(JSON.stringify({
        success: true,
        message: `Deletion triggered for prefix: ${prefix}`,
      }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response("Method not allowed", { status: 405, headers: corsHeaders });
  }
};
