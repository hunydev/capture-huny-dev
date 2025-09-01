export {};

declare global {
  interface Env {
    MYBROWSER: any;     // Puppeteer launch에 전달되는 브라우저 세션
    ASSETS: Fetcher;    // 정적 자산 바인딩
    CAPTURE_KV: any;    // Cloudflare KV 네임스페이스 (키: 호스트명, 값: 이미지 식별자/URL)
    API_TOKEN: string;  // Cloudflare API Token (Images 업로드에 사용) - secret
    IMAGES_ACCOUNT_ID: string; // Cloudflare Images Account ID
  }
}
