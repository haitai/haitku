/**
 * GET /rss — 把最新动态输出为 RSS 2.0。
 * 直接复用 /api/posts 的取数逻辑，避免维护第二套 Notion 请求。
 */
import { onRequestGet as getLivePosts } from './api/posts.js';

const FEED_TITLE = 'haitku';
const FEED_DESC = '一个人的微博客，2007 年至今的碎碎念。';

let mediaCache = null;

/** 静态快照里的 media 映射：Notion 图片 block id → /media/*.webp */
async function loadMedia(origin) {
  if (mediaCache) return mediaCache;
  try {
    const res = await fetch(`${origin}/data/posts.json`, {
      headers: { accept: 'application/json' },
      cf: { cacheEverything: true, cacheTtl: 600 },
    });
    if (res.ok) {
      mediaCache = (await res.json()).media || {};
      return mediaCache;
    }
  } catch {
    /* 读不到快照时退化为使用 Notion 代理地址 */
  }
  return {};
}

const ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ENTITIES[c]);
/** 包 CDATA，顺带处理内容里可能出现的结束标记 */
const cdata = (s) => `<![CDATA[${String(s ?? '').replace(/]]>/g, ']]]]><![CDATA[>')}]]>`;

/** 富文本 run → HTML */
function runsHtml(runs) {
  return (runs || [])
    .map((r) => {
      let t = esc(r.t);
      if (r.b) t = `<strong>${t}</strong>`;
      if (r.i) t = `<em>${t}</em>`;
      if (r.c) t = `<code>${t}</code>`;
      if (r.s) t = `<del>${t}</del>`;
      if (r.u) t = `<u>${t}</u>`;
      if (r.href) t = `<a href="${esc(r.href)}">${t}</a>`;
      return t;
    })
    .join('');
}

/** 正文块 → HTML；图片优先用本站缓存的本地文件 */
function blocksHtml(blocks, media, origin) {
  const out = [];
  let listTag = null;
  const closeList = () => {
    if (listTag) {
      out.push(`</${listTag}>`);
      listTag = null;
    }
  };

  for (const b of blocks || []) {
    if (b.k === 'ul' || b.k === 'ol') {
      if (listTag !== b.k) {
        closeList();
        out.push(`<${b.k}>`);
        listTag = b.k;
      }
      out.push(`<li>${runsHtml(b.r)}</li>`);
      continue;
    }
    closeList();

    switch (b.k) {
      case 'p':
        out.push(`<p>${runsHtml(b.r)}</p>`);
        break;
      case 'h1':
      case 'h2':
      case 'h3':
        out.push(`<${b.k}>${runsHtml(b.r)}</${b.k}>`);
        break;
      case 'quote':
        out.push(`<blockquote>${runsHtml(b.r)}</blockquote>`);
        break;
      case 'img': {
        let src = b.src;
        const hit = /[?&]id=([0-9a-f-]{36})/i.exec(src);
        const local = hit ? media[hit[1]] : undefined;
        if (local) src = local.startsWith('http') ? local : `${origin}${local.startsWith('/') ? '' : '/'}${local}`;
        const dims = `${b.w ? ` width="${b.w}"` : ''}${b.h ? ` height="${b.h}"` : ''}`;
        out.push(`<figure><img src="${esc(src)}" alt="${esc(b.alt || '')}"${dims}></figure>`);
        break;
      }
      case 'hr':
        out.push('<hr>');
        break;
      case 'code':
        out.push(`<pre><code>${esc(b.text)}</code></pre>`);
        break;
      case 'link':
        out.push(`<p><a href="${esc(b.href)}">${esc(b.title || b.href)}</a></p>`);
        break;
      case 'file':
        out.push(`<p><a href="${esc(b.href)}">${esc(b.name || b.href)}</a></p>`);
        break;
      case 'todo':
        out.push(`<p>${b.done ? '☑' : '☐'} ${runsHtml(b.r)}</p>`);
        break;
      case 'toggle':
        out.push(`<p>${runsHtml(b.r)}</p>`);
        break;
      default:
        break;
    }
  }
  closeList();
  return out.join('\n');
}

/** RFC 822（GMT），RSS 2.0 要求 */
function rssDate(value) {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? new Date().toUTCString() : d.toUTCString();
}

const plainOf = (b) => {
  if (b.k === 'code') return b.text;
  if (b.k === 'link') return b.title || b.href;
  if (b.k === 'file') return b.name || b.href;
  if (b.k === 'img' || b.k === 'hr') return '';
  return (b.r || []).map((r) => r.t).join('');
};

export async function onRequestGet(context) {
  const origin = new URL(context?.request?.url || 'https://haitku.pages.dev').origin;

  try {
    const upstream = await getLivePosts(context);
    const data = await upstream.json();
    if (data.error) throw new Error(data.error);

    const media = await loadMedia(origin);
    const items = (data.posts || []).filter((p) => Number.isFinite(p.ts));

    const xml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:atom="http://www.w3.org/2005/Atom">',
      '<channel>',
      `<title>${esc(FEED_TITLE)}</title>`,
      `<link>${esc(origin)}/</link>`,
      `<description>${esc(FEED_DESC)}</description>`,
      '<language>zh-CN</language>',
      `<lastBuildDate>${rssDate(data.updatedAt)}</lastBuildDate>`,
      `<atom:link href="${esc(origin)}/rss" rel="self" type="application/rss+xml" />`,
      ...items.map((p) => {
        const link = `${origin}/#p=${encodeURIComponent(p.id)}`;
        const html = blocksHtml(p.blocks, media, origin);
        const plain = (p.blocks || []).map(plainOf).filter(Boolean).join('\n');
        return [
          '<item>',
          `<title>${esc(p.text || p.date)}</title>`,
          `<link>${esc(link)}</link>`,
          `<guid isPermaLink="true">${esc(link)}</guid>`,
          `<pubDate>${rssDate(p.ts)}</pubDate>`,
          `<description>${cdata([p.text, plain].filter(Boolean).join('\n'))}</description>`,
          `<content:encoded>${cdata(html)}</content:encoded>`,
          '</item>',
        ].join('\n');
      }),
      '</channel>',
      '</rss>',
      '',
    ].join('\n');

    return new Response(xml, {
      status: 200,
      headers: {
        'content-type': 'application/rss+xml; charset=utf-8',
        'cache-control': 'public, max-age=0, s-maxage=60',
        'access-control-allow-origin': '*',
      },
    });
  } catch (err) {
    return new Response(
      `<?xml version="1.0" encoding="UTF-8"?><error>${esc(String(err?.message || err))}</error>`,
      { status: 502, headers: { 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'no-store' } }
    );
  }
}
