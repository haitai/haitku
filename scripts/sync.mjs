/**
 * 从 Notion 公开站点（haitai.notion.site/haitku）同步全部动态。
 * 使用 Notion 站点自身的公开 API（无需 token）：
 *   1. queryCollection 取全部条目
 *   2. syncRecordValuesMain 补齐条目详情
 *   3. 再补取每条动态的正文块（图片、段落、引用…）
 *   4. 把图片下载并压缩到 public/media，避免 Notion 签名地址过期
 * 输出 public/data/posts.json
 *
 *   node scripts/sync.mjs                    全量同步（复用已有图片，供每日自动运行）
 *   node scripts/sync.mjs --no-media        只同步文字，不下载图片
 *   node scripts/sync.mjs --refresh-media   强制重新下载所有图片
 *   node scripts/sync.mjs --prune-media     额外清理不再被引用的图片文件
 *
 * 无内容变化时 posts.json 保持逐字节一致，便于 GitHub Actions 只在有变更时提交。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const HOST = 'https://haitai.notion.site';
const PAGE_URL = `${HOST}/haitku`;
const COLLECTION_ID = '24a52643-186b-818c-9920-000bbbbd6174';
const VIEW_ID = '24a52643-186b-8119-851a-000cc6e5cf2a';
const SPACE_ID = '923a1882-6d13-42f8-9460-f2c249324f99';
const DATE_PROP = ';Bfs';
const MEDIA_DIR = path.resolve('public/media');
const NO_MEDIA = process.argv.includes('--no-media');
const REFRESH_MEDIA = process.argv.includes('--refresh-media');
const PRUNE_MEDIA = process.argv.includes('--prune-media');
const IMG_WIDTH = 1400;

const HEADERS = {
  'Content-Type': 'application/json',
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  'notion-client-version': '23.13.20261110.0041',
  'x-notion-space-id': SPACE_ID,
  'x-notion-active-user-header': '',
  origin: HOST,
  referer: PAGE_URL,
  accept: '*/*',
};

/* ------------------------------- 基础工具 ------------------------------- */

const textOf = (rich) => (rich || []).map((s) => (typeof s[0] === 'string' ? s[0] : '')).join('');

function readDate(raw) {
  if (!Array.isArray(raw) || !raw[0]) return null;
  const holder = raw[0][0];
  let v = null;
  if (holder === 'd') v = raw[0][1];
  else if (holder === '‣' && Array.isArray(raw[0][1])) {
    const found = raw[0][1].find((x) => x[0] === 'd');
    v = found ? found[1] : null;
  }
  if (!v || !v.start_date) return null;
  return v.start_time ? `${v.start_date}T${v.start_time}` : v.start_date;
}

/** 富文本 → 精简 run 数组（只保留会影响观感的标记） */
function richToRuns(rich) {
  const runs = [];
  for (const seg of rich || []) {
    if (!Array.isArray(seg)) continue;
    const text = typeof seg[0] === 'string' ? seg[0] : '';
    if (!text) continue;
    const marks = seg[1] || [];
    const run = { t: text };
    for (const m of marks) {
      if (m[0] === 'b') run.b = 1;
      else if (m[0] === 'i') run.i = 1;
      else if (m[0] === 'c') run.c = 1;
      else if (m[0] === 's') run.s = 1;
      else if (m[0] === '_') run.u = 1;
      else if (m[0] === 'h') run.hl = 1;
    }
    const link = seg[2];
    if (Array.isArray(link) && typeof link[1] === 'string') run.href = link[1];
    runs.push(run);
  }
  return runs;
}

const plain = (value) => {
  const runs = richToRuns(value?.properties?.title);
  return runs.map((r) => r.t).join('');
};

/* ------------------------------- 网络请求 ------------------------------- */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function post(pathname, body, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i += 1) {
    try {
      const res = await fetch(`${HOST}${pathname}`, {
        method: 'POST',
        headers: HEADERS,
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`${pathname} ${res.status}`);
      return await res.json();
    } catch (err) {
      lastErr = err;
      await sleep(600 * (i + 1));
    }
  }
  throw lastErr;
}

async function queryFeed() {
  const data = await post('/api/v3/queryCollection?src=initial_load', {
    clientType: 'notion_app',
    source: { type: 'collection', id: COLLECTION_ID, spaceId: SPACE_ID },
    collectionView: { id: VIEW_ID, spaceId: SPACE_ID },
    loader: {
      reducers: {
        feed_results: { type: 'results', filter: { operator: 'and', filters: [] }, limit: 5000 },
      },
      sort: [{ property: DATE_PROP, direction: 'descending' }],
      searchQuery: '',
      archiveStatus: 'NON_ARCHIVED',
      userTimeZone: 'Asia/Shanghai',
    },
  });
  return {
    ids: data?.result?.reducerResults?.feed_results?.blockIds || [],
    blocks: data?.recordMap?.block || {},
  };
}

/** 批量取块详情（一次最多 ~150 个） */
async function fetchBlocks(ids, label) {
  const out = {};
  const CHUNK = 150;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK);
    const data = await post('/api/v3/syncRecordValuesMain', {
      requests: slice.map((id) => ({
        pointer: { table: 'block', id, spaceId: SPACE_ID },
        version: -1,
      })),
    });
    const got = data?.recordMap?.block || {};
    Object.assign(out, got);
    if (label) process.stdout.write(`\r  ${label} ${Math.min(i + CHUNK, ids.length)}/${ids.length}`);
  }
  if (label && ids.length) process.stdout.write('\n');
  return out;
}

const val = (rec) => rec?.value?.value || null;

/* --------------------------------- 图片 --------------------------------- */

const extFromName = (name = '') => {
  const m = /\.([a-z0-9]{2,5})$/i.exec(name);
  const ext = m ? m[1].toLowerCase() : 'png';
  return ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'svg', 'heic'].includes(ext) ? ext : 'png';
};

function sourceOf(value) {
  const raw = value?.format?.display_source || textOf(value?.properties?.source);
  return raw || null;
}

/** Notion 公开图片代理地址：不带签名，长期有效 */
function proxyUrl(source, blockId, width = IMG_WIDTH) {
  const encoded = encodeURIComponent(source);
  return `${HOST}/image/${encoded}?table=block&id=${blockId}&spaceId=${SPACE_ID}&width=${width}&userId=&cache=v2`;
}

const mediaCache = new Map();

async function downloadImage(blockId, value, index) {
  const source = sourceOf(value);
  if (!source) return null;

  const inlineWidth = Math.round(value?.format?.block_width || 0);
  const aspect = value?.format?.block_aspect_ratio || null;

  if (NO_MEDIA) {
    const url = source.startsWith('attachment:')
      ? proxyUrl(source, blockId)
      : source.startsWith('http')
        ? proxyUrl(source, blockId)
        : null;
    return url ? { src: url, w: inlineWidth || undefined, h: aspect ? Math.round(inlineWidth * aspect) : undefined } : null;
  }

  const cacheKey = `${blockId}:${source}`;
  if (mediaCache.has(cacheKey)) return mediaCache.get(cacheKey);

  const name = source.split(':').pop() || '';
  const remote = source.startsWith('attachment:')
    ? proxyUrl(source, blockId)
    : /^https?:/i.test(source)
      ? source
      : null;
  if (!remote) return null;

  const file = `${blockId}.webp`;
  const dest = path.join(MEDIA_DIR, file);

  /* 已静态化的图片直接复用：每日同步不必重复下载，
     也避免 Notion 临时失败时把本地链接退化成远程代理地址 */
  if (!REFRESH_MEDIA) {
    try {
      const st = await fs.stat(dest);
      if (st.size > 0) {
        const m = await sharp(dest, { animated: true }).metadata();
        const cached = {
          src: `/media/${file}`,
          w: m.width || inlineWidth || undefined,
          h: m.height || undefined,
        };
        mediaCache.set(cacheKey, cached);
        return cached;
      }
    } catch {
      /* 文件不存在或已损坏，走正常下载流程 */
    }
  }

  try {
    const res = await fetch(remote, {
      headers: {
        'User-Agent': HEADERS['User-Agent'],
        'notion-client-version': HEADERS['notion-client-version'],
        referer: PAGE_URL,
      },
    });
    if (!res.ok) throw new Error(`image ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());

    const isGif = /^image\/gif/i.test(res.headers.get('content-type') || '') || /\.gif$/i.test(name);
    const pipeline = sharp(buf, { animated: isGif }).rotate();
    const meta = await pipeline.metadata();
    let out;
    let ext = 'webp';

    if (isGif) {
      out = await pipeline.webp({ quality: 82, effort: 4 }).toBuffer();
    } else {
      const width = Math.min(meta.width || IMG_WIDTH, IMG_WIDTH);
      out = await pipeline.resize({ width, withoutEnlargement: true }).webp({ quality: 82, effort: 4 }).toBuffer();
    }

    await fs.mkdir(MEDIA_DIR, { recursive: true });
    await fs.writeFile(path.join(MEDIA_DIR, `${blockId}.${ext}`), out);
    await fs.rm(path.join(MEDIA_DIR, `${blockId}.${extFromName(name)}`), { force: true });

    const after = await sharp(out, { animated: isGif }).metadata();
    const result = {
      src: `/media/${blockId}.${ext}`,
      w: after.width || inlineWidth || undefined,
      h: after.height || undefined,
      bytes: out.length,
      was: buf.length,
    };
    mediaCache.set(cacheKey, result);
    return result;
  } catch (err) {
    console.warn(`  ! 图片 ${blockId} 下载失败：${err.message}`);
    const fallback = { src: proxyUrl(source, blockId), w: inlineWidth || undefined, remote: 1 };
    mediaCache.set(cacheKey, fallback);
    return fallback;
  }
}

/* ------------------------------ 正文块解析 ------------------------------ */

const SKIP = new Set(['collection_view', 'collection_view_page', 'alias', 'breadcrumb']);
/** 只做容器、本身不渲染的块类型 */
const CONTAINER = new Set(['page', 'column_list', 'column']);

function richText(value) {
  return richToRuns(value?.properties?.title);
}

/**
 * 把 Notion 块树压平成渲染块数组。
 * 列表项带上有序/无序标记，渲染端按顺序画圆点或序号。
 */
function buildBlocks(rootValue, childrenMap, mediaMap) {
  const out = [];
  const walk = (value, depth) => {
    if (!value || depth > 4) return;
    const type = value.type || 'text';
    if (CONTAINER.has(type)) {
      for (const childId of value.content || []) walk(childrenMap.get(childId), depth + 1);
      return;
    }
    if (SKIP.has(type)) return;

    switch (type) {
      case 'text':
      case 'paragraph': {
        const r = richText(value);
        if (r.length) out.push({ k: 'p', r });
        break;
      }
      case 'header':
      case 'heading_1': {
        const r = richText(value);
        if (r.length) out.push({ k: 'h1', r });
        break;
      }
      case 'sub_header':
      case 'heading_2': {
        const r = richText(value);
        if (r.length) out.push({ k: 'h2', r });
        break;
      }
      case 'sub_sub_header':
      case 'heading_3': {
        const r = richText(value);
        if (r.length) out.push({ k: 'h3', r });
        break;
      }
      case 'quote':
      case 'callout': {
        const r = richText(value);
        if (r.length) out.push({ k: 'quote', r });
        break;
      }
      case 'bulleted_list_item':
      case 'numbered_list_item': {
        const r = richText(value);
        if (r.length)
          out.push({ k: type === 'numbered_list_item' ? 'ol' : 'ul', r, id: value.id });
        break;
      }
      case 'to_do': {
        const r = richText(value);
        out.push({ k: 'todo', r, done: value.properties?.checked?.[0]?.[0] === 'Yes' ? 1 : 0 });
        break;
      }
      case 'toggle': {
        const r = richText(value);
        if (r.length) out.push({ k: 'toggle', r });
        break;
      }
      case 'code': {
        const code = plain(value);
        if (code) out.push({ k: 'code', text: code, lang: textOf(value.properties?.language) || '' });
        break;
      }
      case 'image': {
        const media = mediaMap.get(value.id);
        if (media?.src) {
          out.push({
            k: 'img',
            src: media.src,
            w: media.w,
            h: media.h,
            alt: textOf(value.properties?.title) || '',
          });
        }
        break;
      }
      case 'video':
      case 'file':
      case 'pdf': {
        const source = sourceOf(value);
        if (source && /^https?:/i.test(source)) {
          out.push({ k: 'file', href: source, name: textOf(value.properties?.title) || type });
        } else if (source) {
          out.push({ k: 'file', href: proxyUrl(source, value.id), name: textOf(value.properties?.title) || type });
        }
        break;
      }
      case 'bookmark':
      case 'embed':
      case 'link_to_page': {
        const href = textOf(value.properties?.link) || textOf(value.properties?.source) || '';
        if (/^https?:/i.test(href)) {
          out.push({
            k: 'link',
            href,
            title: textOf(value.properties?.title) || href.replace(/^https?:\/\//, ''),
          });
        }
        break;
      }
      case 'divider':
        out.push({ k: 'hr' });
        break;
      case 'equation':
        out.push({ k: 'code', text: plain(value), lang: 'math' });
        break;
      default:
        break;
    }

    for (const childId of value.content || []) {
      walk(childrenMap.get(childId), depth + 1);
    }
  };

  walk(rootValue, 0);
  return out;
}

/* --------------------------------- 主流程 -------------------------------- */

async function main() {
  console.log('查询集合…');
  const { ids, blocks: first } = await queryFeed();
  console.log(`共 ${ids.length} 条，首次返回详情 ${Object.keys(first).length} 条`);

  const missing = ids.filter((id) => !first[id]);
  const extra = missing.length ? await fetchBlocks(missing, '补取条目详情') : {};
  const rows = { ...first, ...extra };

  /* 收集正文子块（可能多层） */
  const children = new Map();
  let frontier = [];
  for (const id of ids) {
    for (const childId of val(rows[id])?.content || []) frontier.push(childId);
  }
  let round = 0;
  while (frontier.length && round < 4) {
    const unknown = [...new Set(frontier)].filter((cid) => !children.has(cid));
    if (!unknown.length) break;
    console.log(`第 ${round + 1} 层正文块 ${unknown.length} 个`);
    const got = await fetchBlocks(unknown, '取正文');
    for (const [cid, rec] of Object.entries(got)) {
      const v = val(rec);
      if (!v) continue;
      children.set(cid, v);
    }
    frontier = [];
    for (const cid of unknown) {
      const v = children.get(cid);
      for (const g of v?.content || []) frontier.push(g);
    }
    round += 1;
  }

  const typeCount = {};
  for (const v of children.values()) typeCount[v.type] = (typeCount[v.type] || 0) + 1;
  console.log('正文块类型:', typeCount);

  /* 图片：先并发下载 */
  const images = [...children.values()].filter((v) => v.type === 'image');
  console.log(`图片 ${images.length} 张`);
  const mediaMap = new Map();
  let done = 0;
  let savedBytes = 0;
  let rawBytes = 0;
  const CONCURRENCY = 6;
  const queue = [...images];
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (queue.length) {
        const img = queue.shift();
        const media = await downloadImage(img.id, img, done);
        if (media?.src) mediaMap.set(img.id, media);
        if (media?.bytes) savedBytes += media.bytes;
        if (media?.was) rawBytes += media.was;
        done += 1;
        process.stdout.write(`\r  图片 ${done}/${images.length}`);
      }
    })
  );
  if (images.length) process.stdout.write('\n');

  /* 组装条目 */
  const posts = [];
  let withBody = 0;
  let withImage = 0;
  let changedAt = 0;

  for (const id of ids) {
    const value = val(rows[id]);
    if (!value) continue;

    /* 数据源最后变更时间，与 /api/posts 的 updatedAt 语义保持一致 */
    for (const t of [value.created_time, value.last_edited_time]) {
      if (typeof t === 'number' && t > changedAt) changedAt = t;
    }

    const text = plain(value).replace(/\r\n/g, '\n').trim();
    const body = buildBlocks(value, children, mediaMap);
    if (!text && !body.length) continue;

    const date = readDate(value.properties?.[DATE_PROP]) || null;
    if (!date) continue;

    const images0 = body.filter((b) => b.k === 'img');
    if (body.length) withBody += 1;
    if (images0.length) withImage += 1;

    const post = {
      id,
      text,
      date,
      ts: Date.parse(date.length === 10 ? `${date}T00:00:00+08:00` : `${date}:00+08:00`),
    };
    if (body.length) {
      post.blocks = body;
      if (images0.length) {
        post.cover = images0[0].src;
        post.media = images0.length;
      }
    }
    posts.push(post);
  }

  posts.sort((a, b) => b.ts - a.ts || a.id.localeCompare(b.id));

  const payload = {
    updatedAt: new Date(changedAt || Date.now()).toISOString(),
    source: PAGE_URL,
    total: posts.length,
    withBody,
    withImage,
    /* 图片块 id → 本地文件，供前端把线上返回的图片地址换成本地缓存 */
    media: Object.fromEntries(
      [...mediaMap.entries()]
        .filter(([, m]) => m.src?.startsWith('/media/'))
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([blockId, m]) => [blockId, m.src])
    ),
    posts,
  };

  const out = path.resolve('public/data/posts.json');
  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.writeFile(out, JSON.stringify(payload));

  /* 默认不清理：每日自动同步时若 Notion 返回不全，误删图片的代价太高。
     需要清理旧文件时手动执行 npm run sync -- --prune-media */
  if (PRUNE_MEDIA && !NO_MEDIA) {
    try {
      const keep = new Set(mediaMap.values().map((m) => path.basename(m.src)));
      const files = await fs.readdir(MEDIA_DIR);
      let removed = 0;
      for (const f of files) {
        if (!keep.has(f)) {
          await fs.rm(path.join(MEDIA_DIR, f), { force: true });
          removed += 1;
        }
      }
      if (removed) console.log(`清理旧图片 ${removed} 个`);
    } catch {
      /* 目录不存在时忽略 */
    }
  }

  const oldest = posts[posts.length - 1];
  console.log(`已写入 ${out}`);
  console.log(`共 ${posts.length} 条 · ${oldest?.date} → ${posts[0]?.date}`);
  console.log(`含正文 ${withBody} 条，含图片 ${withImage} 条`);
  if (rawBytes) {
    console.log(
      `图片压缩：${(rawBytes / 1024 / 1024).toFixed(1)}MB → ${(savedBytes / 1024 / 1024).toFixed(1)}MB`
    );
  }
}

main().catch((err) => {
  console.error('同步失败:', err.message);
  process.exit(1);
});
