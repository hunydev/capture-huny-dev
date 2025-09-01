import puppeteer from "@cloudflare/puppeteer";

function isAllowedUrl(u) {
  try {
    // 스킴이 없으면 https로 간주
    if (!/^https?:\/\//i.test(u)) {
      u = "https://" + u;
    }
    const { hostname, protocol } = new URL(u);
    if (protocol !== "https:" && protocol !== "http:") return false;
    return hostname === "huny.dev" || hostname.endsWith(".huny.dev");
  } catch {
    return false;
  }
}

function normalizeTarget(u) {
  try {
    let s = (u || "").trim();
    if (!s) return null;
    if (!/^https?:\/\//i.test(s)) {
      s = "https://" + s; // 기본 https
    }
    if (!isAllowedUrl(s)) return null;
    return new URL(s).toString();
  } catch {
    return null;
  }
}

function keyFromNormalized(normalizedUrl) {
  try {
    return new URL(normalizedUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const pathname = url.pathname || "/";
    const target = url.searchParams.get("url");
    const hasTarget = typeof target === "string" && target.trim().length > 0;

    // /screenshot 경로 또는 쿼리에 url이 있으면 캡처 API 시도
    if (pathname.startsWith("/screenshot") || pathname.startsWith("/api/screenshot") || hasTarget) {
      if (!hasTarget) {
        return new Response("Missing 'url' query.", { status: 400, headers: { "content-type": "text/plain; charset=utf-8" } });
      }
      const normalized = normalizeTarget(target);
      if (!normalized) {
        return new Response("Only huny.dev domain is allowed.", {
          status: 403,
          headers: { "content-type": "text/plain; charset=utf-8" }
        });
      }

      // 1) KV 캐시 조회: 키는 호스트명 (예: apps.huny.dev)
      const kvKey = keyFromNormalized(normalized);
      if (kvKey && env.CAPTURE_KV) {
        try {
          const cached = await env.CAPTURE_KV.get(kvKey, { type: "text" });
          if (cached) {
            let rec;
            try { rec = JSON.parse(cached); } catch { rec = { url: cached }; }
            const variantUrl = rec?.url;
            if (variantUrl) {
              const imgRes = await fetch(variantUrl);
              const h = new Headers(imgRes.headers);
              h.set("x-capture-worker", "1");
              h.set("x-capture-cache", "hit");
              return new Response(imgRes.body, { status: imgRes.status, statusText: imgRes.statusText, headers: h });
            }
          }
        } catch (e) {
          // KV 오류 시 캐시 무시하고 렌더링 이어감
        }
      }

      const browser = await puppeteer.launch(env.MYBROWSER);
      try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1200, height: 630, deviceScaleFactor: 2 });
        await page.goto(normalized, { waitUntil: "networkidle0", timeout: 20000 });

        const buf = await page.screenshot({ type: "png" });

        // 2) 업로드 → Images → KV 저장 (베스트-effort, 실패해도 응답은 진행)
        ctx?.waitUntil((async () => {
          try {
            if (!env.IMAGES_ACCOUNT_ID || !env.API_TOKEN) return;
            const fd = new FormData();
            fd.append("file", new Blob([buf], { type: "image/png" }), "screenshot.png");
            const api = `https://api.cloudflare.com/client/v4/accounts/${env.IMAGES_ACCOUNT_ID}/images/v1`;
            const upRes = await fetch(api, {
              method: "POST",
              headers: { Authorization: `Bearer ${env.API_TOKEN}` },
              body: fd
            });
            const upJson = await upRes.json();
            if (upRes.ok && upJson?.success && upJson?.result) {
              const imageId = upJson.result.id;
              const variants = upJson.result.variants || [];
              const variantUrl = Array.isArray(variants) && variants.length ? variants[0] : null;
              if (kvKey && variantUrl && env.CAPTURE_KV) {
                await env.CAPTURE_KV.put(kvKey, JSON.stringify({ id: imageId, url: variantUrl }));
              }
            }
          } catch (e) {
            // 업로드 실패는 무시 (로그만 가능하면 좋지만 워커 콘솔에 의존)
          }
        })());

        return new Response(buf, {
          headers: {
            "content-type": "image/png",
            "cache-control": "no-store, no-cache, must-revalidate",
            "x-capture-worker": "1",
            "x-capture-cache": "miss"
          }
        });
      } finally {
        await browser.close();
      }
    }

    // 정적 페이지 반환 (디버깅 헤더 포함)
    const assetRes = await env.ASSETS.fetch(req);
    const h = new Headers(assetRes.headers);
    h.set("x-capture-landing", "1");
    return new Response(assetRes.body, { status: assetRes.status, statusText: assetRes.statusText, headers: h });
  }
};
