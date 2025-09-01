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

function urlKeyFromNormalized(normalizedUrl) {
  // URL 전체를 키로 사용 (레거시 호스트 키와 병행 저장/조회)
  try {
    const u = new URL(normalizedUrl).toString();
    return `url|${u}`;
  } catch {
    return null;
  }
}

function chooseVariant(variants) {
  if (!Array.isArray(variants) || variants.length === 0) return null;
  const pub = variants.find(v => /\/public(?:[\/?]|$)/.test(v));
  return pub || variants[0];
}

function extractImageIdFromVariantUrl(u) {
  try {
    const { hostname, pathname } = new URL(u);
    // imagedelivery.net/<ACCOUNT_HASH>/<IMAGE_ID>/<VARIANT>
    if (!hostname.endsWith("imagedelivery.net")) return null;
    const parts = pathname.split("/").filter(Boolean);
    if (parts.length < 3) return null;
    return parts[1] || null; // [0]=ACCOUNT_HASH, [1]=IMAGE_ID, [2]=VARIANT
  } catch {
    return null;
  }
}

// KV 키 프리픽스: 풀 URL 저장 키
const URL_KEY_PREFIX = "url|";
const CRON_CURSOR_KEY = "cron|cursor:url";
const CRON_BATCH_SIZE = 10; // 한 번의 cron 실행에서 처리할 최대 URL 수(순차 처리)

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const pathname = url.pathname || "/";
    const target = url.searchParams.get("url");
    const hasTarget = typeof target === "string" && target.trim().length > 0;
    const forceParam = url.searchParams.get("force");
    const force = typeof forceParam === "string" && /^(1|true|yes)$/i.test(forceParam);

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

      // 1) KV 캐시 조회: 우선 순위 (풀 URL 키) → (레거시 호스트 키)
      const urlKey = urlKeyFromNormalized(normalized);
      const hostKey = keyFromNormalized(normalized);
      // force인 경우 기존 캐시를 삭제하고 조회를 우회
      if (force && env.CAPTURE_KV) {
        const dels = [];
        if (urlKey) dels.push(env.CAPTURE_KV.delete(urlKey));
        if (hostKey) dels.push(env.CAPTURE_KV.delete(hostKey));
        if (dels.length) ctx?.waitUntil(Promise.allSettled(dels));
      }

      if (!force && env.CAPTURE_KV) {
        try {
          let cached = null;
          if (urlKey) cached = await env.CAPTURE_KV.get(urlKey, { type: "text" });
          if (!cached && hostKey) cached = await env.CAPTURE_KV.get(hostKey, { type: "text" });
          if (cached) {
            let rec;
            try { rec = JSON.parse(cached); } catch { rec = { url: cached }; }
            const variantUrl = rec?.url;
            let id = rec?.id;
            if (!id && variantUrl) {
              const parsed = extractImageIdFromVariantUrl(variantUrl);
              if (parsed) id = parsed;
            }

            // 1) 원본(blob) 우선: 업로드 원본 그대로 전달
            if (id && env.IMAGES_ACCOUNT_ID && env.API_TOKEN) {
              try {
                const blobUrl = `https://api.cloudflare.com/client/v4/accounts/${env.IMAGES_ACCOUNT_ID}/images/v1/${encodeURIComponent(id)}/blob`;
                const blobRes = await fetch(blobUrl, {
                  headers: { Authorization: `Bearer ${env.API_TOKEN}` },
                  cf: { cacheTtl: 0, cacheEverything: false }
                });
                const ct0 = blobRes.headers.get("content-type") || "";
                const isImg0 = ct0.startsWith("image/");
                if (blobRes.ok && isImg0) {
                  const h0 = new Headers();
                  h0.set("content-type", ct0 || "image/png");
                  h0.set("cache-control", "no-store, no-cache, must-revalidate");
                  h0.set("x-capture-worker", "1");
                  h0.set("x-capture-cache", "hit");
                  h0.set("x-capture-source", "original");
                  h0.set("x-images-ct", ct0 || "");
                  h0.set("x-images-id", id);
                  // KV에 id가 없었으면 보강 저장 (id만 저장)
                  if (!rec?.id && env.CAPTURE_KV) {
                    const body = JSON.stringify({ id });
                    const writes = [];
                    if (urlKey) writes.push(env.CAPTURE_KV.put(urlKey, body));
                    if (hostKey) writes.push(env.CAPTURE_KV.put(hostKey, body));
                    ctx?.waitUntil(Promise.allSettled(writes));
                  }
                  return new Response(blobRes.body, { status: blobRes.status, statusText: blobRes.statusText, headers: h0 });
                }
              } catch {}
            }

            if (variantUrl) {
              // PNG 강제 수신 (호환성 확보). 비정상 응답이면 캐시 삭제 후 재생성 폴백.
              const imgRes = await fetch(variantUrl, {
                headers: { Accept: "image/png,*/*;q=0.1" },
                cf: { cacheTtl: 0, cacheEverything: false }
              });
              const ct = imgRes.headers.get("content-type") || "";
              const isImage = ct.startsWith("image/");
              if (imgRes.ok && isImage) {
                const h = new Headers();
                h.set("content-type", ct || "image/png");
                h.set("cache-control", "no-store, no-cache, must-revalidate");
                h.set("x-capture-worker", "1");
                h.set("x-capture-cache", "hit");
                h.set("x-capture-source", "variant");
                h.set("x-images-ct", ct || "");
                try {
                  const u = new URL(variantUrl);
                  const parts = u.pathname.split("/");
                  const tail = parts.slice(-2).join("/");
                  h.set("x-images-ref", tail);
                } catch {}
                return new Response(imgRes.body, { status: imgRes.status, statusText: imgRes.statusText, headers: h });
              } else {
                // 손상/비호환 캐시 → 삭제 후 미스 처리로 폴백
                const dels = [];
                if (urlKey) dels.push(env.CAPTURE_KV.delete(urlKey));
                if (hostKey) dels.push(env.CAPTURE_KV.delete(hostKey));
                if (dels.length) ctx?.waitUntil(Promise.allSettled(dels));
                // continue to capture below
              }
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
            // 공개 변형 접근을 보장 (Signed URL 불필요)
            fd.append("requireSignedURLs", "false");
            const api = `https://api.cloudflare.com/client/v4/accounts/${env.IMAGES_ACCOUNT_ID}/images/v1`;
            const upRes = await fetch(api, {
              method: "POST",
              headers: { Authorization: `Bearer ${env.API_TOKEN}` },
              body: fd
            });
            const upJson = await upRes.json();
            if (upRes.ok && upJson?.success && upJson?.result) {
              const imageId = upJson.result.id;
              if (env.CAPTURE_KV && imageId) {
                const body = JSON.stringify({ id: imageId });
                const puts = [];
                const urlKey2 = urlKeyFromNormalized(normalized);
                const hostKey2 = keyFromNormalized(normalized);
                if (urlKey2) puts.push(env.CAPTURE_KV.put(urlKey2, body));
                if (hostKey2) puts.push(env.CAPTURE_KV.put(hostKey2, body));
                await Promise.allSettled(puts);
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
            "x-capture-cache": force ? "refresh" : "miss"
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
  },

  // Cron 트리거에서 호출: 저장된 URL 키들을 순회하며 강제 재캡처 수행
  async scheduled(controller, env, ctx) {
    if (!env.CAPTURE_KV) return;
    try {
      const cursor = await env.CAPTURE_KV.get(CRON_CURSOR_KEY, { type: "text" });
      const listOpts = { prefix: URL_KEY_PREFIX, limit: CRON_BATCH_SIZE };
      if (cursor) listOpts.cursor = cursor;
      const ls = await env.CAPTURE_KV.list(listOpts);

      if (ls && Array.isArray(ls.keys) && ls.keys.length > 0) {
        const browser = await puppeteer.launch(env.MYBROWSER);
        try {
          for (const k of ls.keys) {
            const name = k?.name;
            if (typeof name !== "string" || !name.startsWith(URL_KEY_PREFIX)) continue;
            const normalized = name.slice(URL_KEY_PREFIX.length);
            if (!isAllowedUrl(normalized)) continue; // 안전 도메인만 처리
            try {
              const page = await browser.newPage();
              await page.setViewport({ width: 1200, height: 630, deviceScaleFactor: 2 });
              await page.goto(normalized, { waitUntil: "networkidle0", timeout: 20000 });
              const buf = await page.screenshot({ type: "png" });
              await page.close();

              // 업로드 후 ID 저장
              if (env.IMAGES_ACCOUNT_ID && env.API_TOKEN) {
                const fd = new FormData();
                fd.append("file", new Blob([buf], { type: "image/png" }), "screenshot.png");
                fd.append("requireSignedURLs", "false");
                const api = `https://api.cloudflare.com/client/v4/accounts/${env.IMAGES_ACCOUNT_ID}/images/v1`;
                const upRes = await fetch(api, { method: "POST", headers: { Authorization: `Bearer ${env.API_TOKEN}` }, body: fd });
                const upJson = await upRes.json();
                if (upRes.ok && upJson?.success && upJson?.result?.id) {
                  const imageId = upJson.result.id;
                  const body = JSON.stringify({ id: imageId });
                  const puts = [];
                  const urlKey2 = urlKeyFromNormalized(normalized);
                  const hostKey2 = keyFromNormalized(normalized);
                  if (urlKey2) puts.push(env.CAPTURE_KV.put(urlKey2, body));
                  if (hostKey2) puts.push(env.CAPTURE_KV.put(hostKey2, body));
                  await Promise.allSettled(puts);
                }
              }
            } catch {
              // 개별 URL 실패는 무시하고 다음 항목 진행
            }
          }
        } finally {
          await browser.close();
        }
      }

      // 커서 저장/초기화
      if (ls?.list_complete) {
        ctx?.waitUntil(env.CAPTURE_KV.delete(CRON_CURSOR_KEY));
      } else if (ls?.cursor) {
        ctx?.waitUntil(env.CAPTURE_KV.put(CRON_CURSOR_KEY, ls.cursor));
      }
    } catch {
      // 리스트/커서 오류는 무시
    }
  }
};
