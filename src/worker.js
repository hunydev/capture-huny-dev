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

// KV 저장 문자열에서 이미지 ID를 추출 (신규 {id} 또는 레거시 {url} 모두 지원)
function getIdFromKVStringValue(cached) {
  if (!cached) return null;
  try {
    const rec = JSON.parse(cached);
    if (rec?.id && typeof rec.id === "string") return rec.id;
    if (rec?.url) {
      const parsed = extractImageIdFromVariantUrl(rec.url);
      if (parsed) return parsed;
    }
  } catch {
    const parsed = extractImageIdFromVariantUrl(cached);
    if (parsed) return parsed;
  }
  return null;
}

// KV 키 프리픽스: 풀 URL 저장 키
const URL_KEY_PREFIX = "url|";
const CRON_CURSOR_KEY = "cron|cursor:url";
const CRON_BATCH_SIZE = 10; // 한 번의 cron 실행에서 처리할 최대 URL 수(순차 처리)

// 타임아웃 및 UA 설정
const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const PREFLIGHT_TIMEOUT_MS = 4000; // 프리플라이트 예비 점검 시간
const GOTO_TIMEOUT_MS = 20000;     // 페이지 진입 타임아웃(dcl)
const IDLE_TIMEOUT_MS = 3000;      // 네트워크 유휴 대기 최대시간
const IDLE_IDLE_TIME_MS = 800;     // 유휴판정 시간
const OVERALL_DEADLINE_MS = 25000; // 전체 캡처 마감시간

function msLeft(deadlineAt) { return Math.max(0, deadlineAt - Date.now()); }
function sleep(ms) { return new Promise((res) => setTimeout(res, ms)); }

async function fetchWithTimeout(resource, init = {}, timeoutMs = 5000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort("timeout"), timeoutMs);
  try {
    return await fetch(resource, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

function jsonError(status, code, message, extraHeaders = {}, extraBody = {}) {
  const h = new Headers({
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-capture-worker": "1",
    "x-capture-fail": code || "error"
  });
  try {
    for (const [k, v] of Object.entries(extraHeaders || {})) {
      if (v !== undefined && v !== null) h.set(k, String(v));
    }
  } catch {}
  const body = JSON.stringify({ ok: false, code, message, ...(extraBody || {}) });
  return new Response(body, { status: status || 500, headers: h });
}

async function preflightCheck(normalized, env, budgetMs) {
  const headers = {
    "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "accept-language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
    "user-agent": DEFAULT_UA
  };
  try {
    // 1) HEAD 우선 시도
    const resHead = await fetchWithTimeout(normalized, {
      method: "HEAD",
      headers,
      redirect: "follow",
      cf: { cacheTtl: 0, cacheEverything: false }
    }, budgetMs);
    if (resHead && resHead.status > 0) {
      if (resHead.status === 405 || resHead.status === 501) {
        // 일부 서버는 HEAD 미지원 → GET 폴백
      } else if (resHead.status >= 200 && resHead.status < 400) {
        return { ok: true };
      } else if (resHead.status === 401 || resHead.status === 403 || resHead.status === 451) {
        return { ok: false, status: 403, code: "preflight-blocked", message: `Blocked (${resHead.status})` };
      } else if (resHead.status >= 500) {
        return { ok: false, status: 504, code: "preflight-upstream", message: `Upstream error (${resHead.status})` };
      }
    }
    // 2) GET 폴백 (짧은 시간)
    const resGet = await fetchWithTimeout(normalized, {
      method: "GET",
      headers,
      redirect: "follow",
      cf: { cacheTtl: 0, cacheEverything: false }
    }, Math.max(1000, Math.min(2500, budgetMs)));
    if (resGet.status >= 200 && resGet.status < 400) return { ok: true };
    if (resGet.status === 401 || resGet.status === 403 || resGet.status === 451) {
      return { ok: false, status: 403, code: "preflight-blocked", message: `Blocked (${resGet.status})` };
    }
    if (resGet.status >= 500) return { ok: false, status: 504, code: "preflight-upstream", message: `Upstream error (${resGet.status})` };
    // 기타 4xx는 빠른 실패 처리
    return { ok: false, status: 403, code: "preflight-rejected", message: `Rejected (${resGet.status})` };
  } catch (e) {
    return { ok: false, status: 504, code: "preflight-timeout", message: "Preflight timeout or network error" };
  }
}

async function setupPageForCapture(page) {
  await page.setUserAgent(DEFAULT_UA);
  await page.setExtraHTTPHeaders({ "accept-language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7" });
  // 트래커/애널리틱스 일부 차단으로 안정화
  const blocked = [
    "googletagmanager.com",
    "google-analytics.com",
    "doubleclick.net",
    "googlesyndication.com",
    "facebook.net",
    "facebook.com",
    "hotjar.com",
    "hotjar.io",
    "segment.io",
    "amplitude.com",
    "mixpanel.com",
    "clarity.ms",
    "yandex.ru",
    "yandex.com",
    "cloudflareinsights.com"
  ];
  try {
    await page.setRequestInterception(true);
    page.on("request", req => {
      const url = req.url();
      const type = req.resourceType();
      // ping/beacon류와 일부 트래커 스크립트/요청 차단
      if (type === "ping" || type === "beacon") return req.abort();
      if (blocked.some(d => url.includes(d))) return req.abort();
      return req.continue();
    });
  } catch {}
}

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
        return jsonError(400, "bad-request", "Missing 'url' query.", { "x-capture-cache": "miss" });
      }
      const normalized = normalizeTarget(target);
      if (!normalized) {
        return jsonError(403, "domain-not-allowed", "Only huny.dev domain is allowed.", { "x-capture-cache": "miss" });
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

      // 프리플라이트로 방화벽/차단/연결 불가를 빠르게 식별
      const deadlineAt = Date.now() + OVERALL_DEADLINE_MS;
      const pf = await preflightCheck(normalized, env, Math.min(PREFLIGHT_TIMEOUT_MS, msLeft(deadlineAt)));
      if (!pf.ok) {
        return jsonError(pf.status || 504, pf.code || "preflight", pf.message || "Preflight failed", {
          "x-capture-cache": force ? "refresh-preflight" : "miss-preflight"
        });
      }

      let browser;
      try {
        browser = await puppeteer.launch(env.MYBROWSER);
        try {
          const page = await browser.newPage();
          await setupPageForCapture(page);
          await page.setViewport({ width: 1200, height: 630, deviceScaleFactor: 2 });
          const gotoTimeout = Math.max(1000, Math.min(GOTO_TIMEOUT_MS, msLeft(deadlineAt)));
          try {
            await page.goto(normalized, { waitUntil: "domcontentloaded", timeout: gotoTimeout });
          } catch {}
          const settleWait = Math.min(IDLE_IDLE_TIME_MS, Math.max(0, Math.min(IDLE_TIMEOUT_MS, msLeft(deadlineAt))));
          if (settleWait > 0) await sleep(settleWait);

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
      } catch (e) {
        const name = (e && (e.name || e.code || e.type)) ? String(e.name || e.code || e.type) : "";
        const msg = e && e.message ? String(e.message) : "Capture failed";
        const isTimeout = name === "TimeoutError" || /\btimeout\b|\btimed out\b/i.test(msg);
        return jsonError(isTimeout ? 504 : 500, isTimeout ? "capture-timeout" : "capture-failed", msg, {
          "x-capture-cache": force ? "refresh-fail" : "miss-fail"
        });
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
              // 프리플라이트로 빠른 차단
              const sDeadlineAt = Date.now() + OVERALL_DEADLINE_MS;
              const pf2 = await preflightCheck(normalized, env, Math.min(PREFLIGHT_TIMEOUT_MS, msLeft(sDeadlineAt)));
              if (!pf2.ok) continue;

              const page = await browser.newPage();
              await setupPageForCapture(page);
              await page.setViewport({ width: 1200, height: 630, deviceScaleFactor: 2 });
              const gotoTimeout2 = Math.max(1000, Math.min(GOTO_TIMEOUT_MS, msLeft(sDeadlineAt)));
              try {
                await page.goto(normalized, { waitUntil: "domcontentloaded", timeout: gotoTimeout2 });
              } catch {}
              const settleWait2 = Math.min(IDLE_IDLE_TIME_MS, Math.max(0, Math.min(IDLE_TIMEOUT_MS, msLeft(sDeadlineAt))));
              if (settleWait2 > 0) await sleep(settleWait2);
              const buf = await page.screenshot({ type: "png" });
              await page.close();

              // 업로드 후 ID 저장
              if (env.IMAGES_ACCOUNT_ID && env.API_TOKEN) {
                // 1) 기존 이미지 ID 조회 (url 키 우선, 없으면 host 키)
                const urlKey2 = urlKeyFromNormalized(normalized);
                const hostKey2 = keyFromNormalized(normalized);
                let prevId = null;
                try {
                  if (urlKey2) {
                    const prevVal = await env.CAPTURE_KV.get(urlKey2, { type: "text" });
                    prevId = getIdFromKVStringValue(prevVal);
                  }
                  if (!prevId && hostKey2) {
                    const prevVal2 = await env.CAPTURE_KV.get(hostKey2, { type: "text" });
                    prevId = getIdFromKVStringValue(prevVal2);
                  }
                } catch {}

                // 2) 신규 업로드
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
                  if (urlKey2) puts.push(env.CAPTURE_KV.put(urlKey2, body));
                  if (hostKey2) puts.push(env.CAPTURE_KV.put(hostKey2, body));
                  await Promise.allSettled(puts);

                  // 3) 이전 이미지 삭제 (성공적으로 신규 저장된 뒤)
                  if (prevId && prevId !== imageId) {
                    try {
                      const delUrl = `https://api.cloudflare.com/client/v4/accounts/${env.IMAGES_ACCOUNT_ID}/images/v1/${encodeURIComponent(prevId)}`;
                      await fetch(delUrl, { method: "DELETE", headers: { Authorization: `Bearer ${env.API_TOKEN}` } });
                    } catch {}
                  }
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
