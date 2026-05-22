/**
 * Instagram Public Data Scraper (Playwright 版)
 * 策略：拦截 IG 内部 API 响应，提取帖子数据，无需登录
 * 运行：node scraper.js
 */

const { chromium } = require("playwright");
const fs = require("fs");

const ACCOUNTS = ["sinchewdaily", "coinsauce"];
const POSTS_TARGET = 20;
const OUTPUT_FILE = "ig_data.json";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function detectType(node) {
  if (node.__typename === "GraphSidecar" || node.product_type === "carousel_container") return "carousel";
  if (node.__typename === "GraphVideo" || node.is_video || node.media_type === 2) return "video";
  return "image";
}

// 从 API 响应提取帖子列表，同时返回分页信息
function extractPosts(data) {
  const posts = [];
  let pageInfo = null;
  let userId = null;

  // 格式一：web_profile_info → data.user.edge_owner_to_timeline_media
  try {
    const user =
      data?.data?.user ||
      data?.graphql?.user;
    const timeline = user?.edge_owner_to_timeline_media;
    if (timeline?.edges?.length) {
      userId = user.id;
      pageInfo = timeline.page_info; // { has_next_page, end_cursor }
      for (const { node: n } of timeline.edges) {
        posts.push({
          url: `https://www.instagram.com/p/${n.shortcode}/`,
          likes: n.edge_media_preview_like?.count ?? n.like_count ?? null,
          comments: n.edge_media_to_comment?.count ?? n.comments_count ?? null,
          caption: n.edge_media_to_caption?.edges?.[0]?.node?.text ?? n.caption ?? "",
          timestamp: new Date((n.taken_at_timestamp ?? n.taken_at) * 1000).toISOString(),
          type: detectType(n),
        });
      }
      return { posts, pageInfo, userId };
    }
  } catch (_) {}

  // 格式二：/feed/user/ → items[]
  try {
    const items = data?.items || data?.data?.items;
    if (items?.length) {
      for (const n of items) {
        const code = n.code || n.shortcode;
        posts.push({
          url: code ? `https://www.instagram.com/p/${code}/` : null,
          likes: n.like_count ?? null,
          comments: n.comment_count ?? null,
          caption: n.caption?.text ?? "",
          timestamp: new Date((n.taken_at ?? n.device_timestamp) * 1000).toISOString(),
          type: detectType(n),
        });
      }
      // feed/user 分页用 next_max_id
      pageInfo = data?.next_max_id ? { has_next_page: true, end_cursor: data.next_max_id } : null;
      return { posts, pageInfo, userId: null };
    }
  } catch (_) {}

  // 格式三：graphql/query 变种
  try {
    const conn = data?.data?.xdt_api__v1__feed__user_timeline_graphql_connection;
    if (conn?.edges?.length) {
      pageInfo = conn.page_info;
      for (const { node: n } of conn.edges) {
        const media = n?.media ?? n;
        const code = media.code || media.shortcode;
        posts.push({
          url: code ? `https://www.instagram.com/p/${code}/` : null,
          likes: media.like_count ?? null,
          comments: media.comment_count ?? null,
          caption: media.caption?.text ?? "",
          timestamp: new Date((media.taken_at ?? media.device_timestamp) * 1000).toISOString(),
          type: detectType(media),
        });
      }
      return { posts, pageInfo, userId: null };
    }
  } catch (_) {}

  return { posts, pageInfo: null, userId: null };
}

async function scrapeAccount(browser, username) {
  console.log(`\n[@${username}] 开始抓取...`);

  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    locale: "en-US",
    viewport: { width: 1280, height: 900 },
    extraHTTPHeaders: {
      "Accept-Language": "en-US,en;q=0.9",
      "sec-ch-ua": '"Chromium";v="124", "Google Chrome";v="124"',
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": '"macOS"',
    },
  });

  const allCaptured = [];

  // 拦截所有 IG API 响应
  context.on("response", async (response) => {
    const url = response.url();
    const relevant =
      url.includes("web_profile_info") ||
      url.includes("/feed/user/") ||
      url.includes("graphql/query") ||
      url.includes("api/v1/feed") ||
      url.includes("api/v1/users/");

    if (!relevant) return;

    try {
      const json = await response.json();
      allCaptured.push({ url, data: json });
    } catch (_) {}
  });

  const page = await context.newPage();

  // 隐藏 webdriver 特征
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
    Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3] });
    window.chrome = { runtime: {} };
  });

  let posts = [];
  let pageInfo = null;
  let userId = null;
  const seen = new Set();

  function mergePosts(extracted) {
    const { posts: newPosts, pageInfo: pi, userId: uid } = extracted;
    if (pi) pageInfo = pi;
    if (uid) userId = uid;
    for (const p of newPosts) {
      if (p.url && !seen.has(p.url)) {
        seen.add(p.url);
        posts.push(p);
      }
    }
  }

  try {
    // ── 尝试一：直接访问 profile API（无 cookie 可能 403）
    try {
      const apiResp = await page.request.get(
        `https://www.instagram.com/api/v1/users/web_profile_info/?username=${username}`,
        {
          headers: {
            "x-ig-app-id": "936619743392459",
            Referer: "https://www.instagram.com/",
            "Accept-Language": "en-US,en;q=0.9",
          },
        }
      );
      if (apiResp.ok()) {
        const json = await apiResp.json();
        mergePosts(extractPosts(json));
        if (posts.length) {
          console.log(`  [@${username}] 直接 API 获取 ${posts.length} 条`);
        }
      }
    } catch (_) {}

    // ── 尝试二：加载 profile 页面，拦截网络响应
    await page.goto(`https://www.instagram.com/${username}/`, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    await sleep(4000);

    // 向下滚动触发更多 API 请求
    for (let i = 0; i < 4; i++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await sleep(2500);
    }

    // 解析拦截到的网络响应
    for (const { url, data } of allCaptured) {
      const r = extractPosts(data);
      if (r.posts.length) {
        const before = posts.length;
        mergePosts(r);
        if (posts.length > before) {
          console.log(
            `  [@${username}] 网络拦截 (...${url.split("/").slice(-2).join("/").slice(0, 40)}) +${posts.length - before} 条`
          );
        }
      }
    }

    // ── 尝试三：分页抓取（用 end_cursor + graphql）
    if (posts.length < POSTS_TARGET && userId && pageInfo?.has_next_page) {
      console.log(`  [@${username}] 尝试分页抓取 (end_cursor exists)...`);
      let cursor = pageInfo.end_cursor;
      let attempts = 0;

      while (posts.length < POSTS_TARGET && cursor && attempts < 3) {
        attempts++;
        try {
          const vars = JSON.stringify({ id: userId, first: 12, after: cursor });
          const qhash = "e769aa130647d2354c40ea6a439bfc08"; // user_timeline hash
          const gqlResp = await page.request.get(
            `https://www.instagram.com/graphql/query/?query_hash=${qhash}&variables=${encodeURIComponent(vars)}`,
            {
              headers: {
                "x-ig-app-id": "936619743392459",
                Referer: `https://www.instagram.com/${username}/`,
              },
            }
          );
          if (gqlResp.ok()) {
            const json = await gqlResp.json();
            const r = extractPosts(json);
            const before = posts.length;
            mergePosts(r);
            console.log(`  [@${username}] 分页第${attempts}页 +${posts.length - before} 条`);
            cursor = pageInfo?.has_next_page ? pageInfo.end_cursor : null;
            await sleep(1500);
          } else {
            break;
          }
        } catch (e) {
          console.log(`  [@${username}] 分页失败: ${e.message}`);
          break;
        }
      }
    }

    // ── 备用：从页面内嵌 script 标签解析
    if (posts.length === 0) {
      const extracted = await page.evaluate(() => {
        for (const s of document.querySelectorAll("script[type='application/json']")) {
          try {
            const d = JSON.parse(s.textContent || "{}");
            if (JSON.stringify(d).includes("edge_owner_to_timeline_media")) return [d];
          } catch (_) {}
        }
        return [];
      });
      for (const d of extracted) {
        const r = extractPosts(d);
        if (r.posts.length) {
          mergePosts(r);
          console.log(`  [@${username}] 页面内嵌 JSON 获取 ${posts.length} 条`);
          break;
        }
      }
    }

  } catch (err) {
    console.error(`  [@${username}] 抓取出错: ${err.message}`);
  } finally {
    await context.close();
  }

  const result = posts.slice(0, POSTS_TARGET);
  console.log(
    posts.length === 0
      ? `  [@${username}] ⚠️  无数据（IG 未登录限制，可能触发 login wall）`
      : `  [@${username}] 完成，共 ${result.length} 条`
  );
  return result;
}

async function main() {
  console.log("══════════════════════════════════════════");
  console.log("  Instagram Scraper (Playwright)");
  console.log(`  账号: ${ACCOUNTS.map((a) => "@" + a).join(", ")}`);
  console.log(`  目标: 每账号最多 ${POSTS_TARGET} 条`);
  console.log("══════════════════════════════════════════");

  const browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-blink-features=AutomationControlled",
      "--disable-dev-shm-usage",
    ],
  });

  const result = {
    last_updated: new Date().toISOString(),
    accounts: {},
  };

  try {
    for (let i = 0; i < ACCOUNTS.length; i++) {
      const account = ACCOUNTS[i];
      result.accounts[account] = await scrapeAccount(browser, account);

      if (i < ACCOUNTS.length - 1) {
        console.log("  等待 4 秒避免速率限制...");
        await sleep(4000);
      }
    }
  } finally {
    await browser.close();
    console.log("\n  浏览器已关闭");
  }

  // 保存 JSON
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(result, null, 2), "utf-8");
  console.log(`\n✓ 已保存 → ${OUTPUT_FILE}`);

  // 摘要
  console.log("\n── 摘要 ──────────────────────────────────");
  for (const [account, posts] of Object.entries(result.accounts)) {
    if (posts.length > 0) {
      const latest = posts[0];
      console.log(
        `  @${account.padEnd(16)} ${posts.length} 条 | 最新 ${latest.timestamp?.slice(0, 10)} | ${latest.type} | 赞 ${latest.likes ?? "N/A"}`
      );
    } else {
      console.log(`  @${account.padEnd(16)} 0 条（login wall 或无公开数据）`);
    }
  }
  console.log("──────────────────────────────────────────");
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
