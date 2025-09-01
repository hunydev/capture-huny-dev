export {};

declare global {
  interface Env {
    MYBROWSER: any;     // Puppeteer launch에 전달되는 브라우저 세션
    ASSETS: Fetcher;    // 정적 자산 바인딩
  }
}
