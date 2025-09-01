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

export default {
  async fetch(req, env) {
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

      const browser = await puppeteer.launch(env.MYBROWSER);
      try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1200, height: 630, deviceScaleFactor: 2 });
        await page.goto(normalized, { waitUntil: "networkidle0", timeout: 20000 });

        const buf = await page.screenshot({ type: "png" });
        return new Response(buf, {
          headers: {
            "content-type": "image/png",
            "cache-control": "no-store, no-cache, must-revalidate",
            "x-capture-worker": "1"
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
