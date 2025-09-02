# capture.huny.dev

Cloudflare Workers + Browser Rendering(Puppeteer)를 이용해
`?url=...` 파라미터로 전달된 페이지를 실제로 렌더링하고
스크린샷(썸네일)을 반환하는 서비스입니다.

## 동작 정책
- huny.dev 및 하위 도메인: 항상 Puppeteer 렌더링 캡처 수행 (KV/Images 캐시 우선, force=1 시 재생성)
- 그 외 도메인: 소셜 메타(OG/Twitter/itemprop/link[image_src])만 사용. 존재하지 않으면 404

## 엔드포인트
- GET /screenshot?url=https://...  (또는 /api/screenshot, 혹은 루트에서 ?url=)

## 쿼리 파라미터
- url: 캡처/프록시할 대상 페이지 URL (필수)
- force: 1|true|yes -> 캐시 우회 후 재생성 (선택)

## 캐시
- KV(CAPTURE_KV)에 메타/매핑 저장. Cloudflare Images에 PNG 업로드하여 재사용
- force=1이면 해당 URL 관련 KV/Images 레코드 무시/삭제 후 재생성

## 응답 헤더(일부)
- x-capture-cache: hit|miss|meta-miss|refresh|... (캐시 상태/경로)
- x-capture-source: capture|meta|original|variant (이미지 출처)
- x-capture-worker: 1 (워커 응답 표시)
- x-capture-fail: 오류 코드(있는 경우)

## 오류
- 400 invalid-url: URL 형식 오류 또는 http/https 외 스킴
- 403 domain-not-allowed: huny.dev 외 도메인에서 렌더링 요청 시
- 404 social-not-found: 비-huny.dev에서 소셜 메타 이미지가 없을 때
- 504 timeout: 렌더링 단계 타임아웃 등

## 배포/개발
- 개발: npm start (wrangler dev)
- 배포: npm run deploy (wrangler deploy)

자세한 동작은 `src/worker.js`를 참고하세요.
