// Test-only child-process preload. Production application configuration cannot change provider endpoints.
const endpoint = process.env.TEST_WECHAT_LOOPBACK;
if (!endpoint)
  throw new Error("TEST_WECHAT_LOOPBACK is required for the test preload");
const loopback = new URL(endpoint);
if (loopback.protocol !== "http:" || loopback.hostname !== "127.0.0.1")
  throw new Error("WeChat test transport must use loopback HTTP");
const original = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(
    typeof input === "string" || input instanceof URL
      ? String(input)
      : input.url,
  );
  if (
    url.origin === "https://api.weixin.qq.com" &&
    url.pathname === "/sns/oauth2/access_token"
  ) {
    const target = new URL(loopback);
    target.search = url.search;
    return original(target, init);
  }
  return original(input, init);
};
