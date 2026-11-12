/**
 * GET /api/posts
 * 轻量代理：从 Notion 公开站点拉取「最新 N 条」动态（含正文与图片），
 * 供前端与静态快照合并。边缘缓存 1 分钟。
 */
const HOST = 'https://haitai.notion.site';
const COLLECTION_ID = '24a52643-186b-818c-9920-000bbbbd6174';
const VIEW_ID = '24a52643-186b-8119-851a-000cc6e5cf2a';
const SPACE_ID = '923a1882-6d13-42f8-9460-f2c249324f99';
const DATE_PROP = ';Bfs';
const LIMIT = 80;

const json = (data, status = 200, cache = 'public, max-age=0, s-maxage=60') =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': cache,
      'access-control-allow-origin': '*',
    },
  });

const HEADERS = {
  'content-type': 'application/json',
  'notion-client-version': '23.13.20261110.0041',
  'x-notion-space-id': SPACE_ID,
  'x-notion-active-user-header': '',
  origin: HOST,
  referer: `${HOST}/haitku`,
};

const textOf = (rich) => (rich || []).map((s) => (typeof s[0] === 'string' ? s[0] : '')).join('');
const val = (rec) => rec?.value?.value || null;

function dateOf(props) {
  const raw = props[DATE_PROP];
  if (!Array.isArray(raw) || !raw[0]) return null;
  let v = null;
  if (raw[0][0] === 'd') v = raw[0][1];
  else if (raw[0][0] === '‣' && Array.isArray(raw[0][1])) {
    const hit = raw[0][1].find((x) => x[0] === 'd');
    v = hit ? hit[1] : null;
  }
  if (!v || !v.start_date) return null;
  return v.start_time ? `${v.start_date}T${v.start_time}` : v.start_date;
}

/* 富文本 → 精简 run */
function runs(rich) {
  const out = [];
  for (const seg of rich || []) {
    if (!Array.isArray(seg)) continue;
    const t = typeof seg[0] === 'string' ? seg[0] : '';
    if (!t) continue;
    const run = { t };
    for (const m of seg[1] || []) {
      if (m[0] === 'b') run.b = 1;
      else if (m[0] === 'i') run.i = 1;
      else if (m[0] === 'c') run.c = 1;
      else if (m[0] === 's') run.s = 1;
      else if (m[0] === '_') run.u = 1;
    }
    const link = seg[2];
    if (Array.isArray(link) && typeof link[1] === 'string') run.href = link[1];
    out.push(run);
  }
  return out;
}

/** 正文块：只处理常见的几种，图片走 Notion 公开代理地址 */
function blocksOf(page, children) {
  const out = [];
  const walk = (value, depth) => {
    if (!value || depth > 3) return;
    const type = value.type;
    if (type === 'page' || type === 'column_list' || type === 'column') {
      for (const id of value.content || []) walk(children.get(id), depth + 1);
      return;
    }
    switch (type) {
      case 'text':
      case 'paragraph': {
        const r = runs(value.properties?.title);
        if (r.length) out.push({ k: 'p', r });
        break;
      }
      case 'header':
      case 'heading_1': {
        const r = runs(value.properties?.title);
        if (r.length) out.push({ k: 'h1', r });
        break;
      }
      case 'sub_header':
      case 'heading_2': {
        const r = runs(value.properties?.title);
        if (r.length) out.push({ k: 'h2', r });
        break;
      }
      case 'sub_sub_header':
      case 'heading_3': {
        const r = runs(value.properties?.title);
        if (r.length) out.push({ k: 'h3', r });
        break;
      }
      case 'quote':
      case 'callout': {
        const r = runs(value.properties?.title);
        if (r.length) out.push({ k: 'quote', r });
        break;
      }
      case 'bulleted_list_item':
      case 'numbered_list_item': {
        const r = runs(value.properties?.title);
        if (r.length) out.push({ k: type === 'numbered_list_item' ? 'ol' : 'ul', r });
        break;
      }
      case 'image': {
        const source = value.format?.display_source || textOf(value.properties?.source);
        if (source) {
          const src = `${HOST}/image/${encodeURIComponent(source)}?table=block&id=${value.id}&spaceId=${SPACE_ID}&width=1400&userId=&cache=v2`;
          const w = Math.round(value.format?.block_width || 0);
          const ratio = value.format?.block_aspect_ratio;
          out.push({
            k: 'img',
            src,
            w: w || undefined,
            h: w && ratio ? Math.round(w * ratio) : undefined,
            alt: textOf(value.properties?.title),
          });
        }
        break;
      }
      case 'divider':
        out.push({ k: 'hr' });
        break;
      default:
        break;
    }
    for (const id of value.content || []) walk(children.get(id), depth + 1);
  };

  walk(page, 0);
  return out;
}

async function post(path, body) {
  const res = await fetch(`${HOST}${path}`, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify(body),
    cf: { cacheEverything: true, cacheTtl: 60 },
  });
  if (!res.ok) throw new Error(`upstream ${res.status}`);
  return res.json();
}

export async function onRequestGet() {
  try {
    const data = await post('/api/v3/queryCollection?src=initial_load', {
      clientType: 'notion_app',
      source: { type: 'collection', id: COLLECTION_ID, spaceId: SPACE_ID },
      collectionView: { id: VIEW_ID, spaceId: SPACE_ID },
      loader: {
        reducers: {
          feed_results: { type: 'results', filter: { operator: 'and', filters: [] }, limit: LIMIT },
        },
        sort: [{ property: DATE_PROP, direction: 'descending' }],
        searchQuery: '',
        archiveStatus: 'NON_ARCHIVED',
        userTimeZone: 'Asia/Shanghai',
      },
    });

    const ids = data?.result?.reducerResults?.feed_results?.blockIds || [];
    const blocks = data?.recordMap?.block || {};
    const values = ids.map((id) => val(blocks[id])).filter(Boolean);

    /* 有正文的条目，再补一次正文块 */
    const childIds = [...new Set(values.flatMap((v) => v.content || []))];
    const children = new Map();
    if (childIds.length) {
      try {
        const extra = await post('/api/v3/syncRecordValuesMain', {
          requests: childIds.slice(0, 150).map((id) => ({
            pointer: { table: 'block', id, spaceId: SPACE_ID },
            version: -1,
          })),
        });
        for (const [id, rec] of Object.entries(extra?.recordMap?.block || {})) {
          const v = val(rec);
          if (v) children.set(id, v);
        }
      } catch {
        /* 正文拿不到不影响条目本身 */
      }
    }

    /* 数据源最后一次变更时间：取所有条目的 created/last_edited 最大值。
       这样「数据更新于」反映的是 Notion 里的真实改动，而不是本次请求时刻。 */
    const changedAt = values.reduce((max, v) => {
      for (const t of [v.created_time, v.last_edited_time]) {
        if (typeof t === 'number' && t > max) max = t;
      }
      return max;
    }, 0);

    const posts = values
      .map((value) => {
        const text = textOf(value.properties?.title).replace(/\r\n/g, '\n').trim();
        const body = blocksOf(value, children);
        if (!text && !body.length) return null;
        const date = dateOf(value.properties || {});
        if (!date) return null;
        const post = {
          id: value.id,
          text,
          date,
          ts: Date.parse(date.length === 10 ? `${date}T00:00:00+08:00` : `${date}:00+08:00`),
        };
        if (body.length) {
          post.blocks = body;
          const imgs = body.filter((b) => b.k === 'img');
          if (imgs.length) {
            post.cover = imgs[0].src;
            post.media = imgs.length;
          }
        }
        return post;
      })
      .filter(Boolean);

    /* 本次窗口覆盖到的最早时间：前端据此判断快照里哪些条目已被删除/归档 */
    const stamps = posts.map((p) => p.ts).filter(Number.isFinite);
    const windowStart = stamps.length ? Math.min(...stamps) : undefined;

    return json({
      updatedAt: new Date(changedAt || Date.now()).toISOString(),
      fetchedAt: new Date().toISOString(),
      windowStart,
      total: posts.length,
      posts,
    });
  } catch (err) {
    return json({ error: String(err?.message || err) }, 502, 'no-store');
  }
}
