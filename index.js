const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const path = require('path');
const { Pool } = require('pg');

const app = express();
const port = process.env.PORT || 3000;

// [1] DB 연결 설정 (Render 환경 변수 사용)
let pool;
if (process.env.DATABASE_URL) {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
}

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// [2] 핵심 프록시 엔진
app.get('/proxy', async (req, res) => {
  let targetUrl = req.query.url;

  // 검색어 파라미터(q, query) 대응
  if (!targetUrl) {
    if (req.query.query) {
      targetUrl = `https://search.naver.com/search.naver?query=${encodeURIComponent(req.query.query)}`;
    } else if (req.query.q) {
      targetUrl = `https://www.bing.com/search?q=${encodeURIComponent(req.query.q)}`;
    }
  }

  if (!targetUrl) return res.status(400).send('URL이 필요합니다.');

  try {
    const userAgent = req.headers['user-agent'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36';

    const response = await axios.get(targetUrl, {
      headers: { 
        'User-Agent': userAgent,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
        'Referer': new URL(targetUrl).origin 
      },
      responseType: 'arraybuffer',
      timeout: 15000,
      validateStatus: false
    });

    const contentType = response.headers['content-type'] || '';
    res.set('Content-Type', contentType);

    // [HTML 처리]
    if (contentType.includes('text/html')) {
      let html = response.data.toString('utf-8');
      const $ = cheerio.load(html);

      // (1) 기본 태그 리라이팅 (상대경로 -> 절대경로 변환)
      const rewrite = (tag, attr) => {
        $(tag).each((i, el) => {
          const val = $(el).attr(attr);
          if (val && !val.startsWith('data:') && !val.startsWith('javascript:')) {
            try {
              const absolute = new URL(val, targetUrl).href;
              $(el).attr(attr, `/proxy?url=${encodeURIComponent(absolute)}`);
            } catch (e) {}
          }
        });
      };

      rewrite('img', 'src');
      rewrite('img', 'srcset');
      rewrite('link', 'href');
      rewrite('script', 'src');
      rewrite('source', 'src');
      rewrite('a', 'href');

      // (2) 클라이언트 사이드 스크립트 주입 (클릭 및 동적 요청 가로채기)
      const injectScript = `
        <script>
          // 1. 모든 클릭 이벤트 감시 및 프록시 경로 강제 주입
          document.addEventListener('click', function(e) {
            const a = e.target.closest('a');
            if (a && a.href && !a.href.startsWith(window.location.origin + '/proxy')) {
              if (a.href.startsWith('javascript:') || a.href.startsWith('#')) return;
              e.preventDefault();
              const target = new URL(a.href, window.location.href).href;
              window.location.href = '/proxy?url=' + encodeURIComponent(target);
            }
          }, true);

          // 2. 모든 폼 전송 가로채기
          document.addEventListener('submit', function(e) {
            const form = e.target;
            if (form.action && !form.action.startsWith(window.location.origin + '/proxy')) {
              e.preventDefault();
              const action = new URL(form.action, window.location.href).href;
              const formData = new URLSearchParams(new FormData(form)).toString();
              const separator = action.includes('?') ? '&' : '?';
              window.location.href = '/proxy?url=' + encodeURIComponent(action + separator + formData);
            }
          }, true);
        </script>
      `;
      $('head').append(injectScript);

      // (3) 보안 정책(CSP) 무력화
      $('meta[http-equiv="Content-Security-Policy"]').remove();
      $('meta[http-equiv="content-security-policy"]').remove();

      if (pool) {
        pool.query('INSERT INTO history (url) VALUES ($1)', [targetUrl]).catch(() => {});
      }

      return res.send($.html());
    }

    // [CSS 처리]
    if (contentType.includes('text/css')) {
      let css = response.data.toString('utf-8');
      css = css.replace(/url\\(['\"]?([^'\")]*)['\"]?\\)/g, (match, p1) => {
        try {
          if (p1.startsWith('data:')) return match;
          const absolute = new URL(p1, targetUrl).href;
          return \`url("/proxy?url=\${encodeURIComponent(absolute)}")\`;
        } catch (e) { return match; }
      });
      return res.send(css);
    }

    res.send(response.data);

  } catch (error) {
    res.status(500).send(`접속 오류: \${error.message}`);
  }
});

// [3] 경로 이탈 대응 (/search 요청 수신)
app.get('/search', (req, res) => {
  const query = req.query.query || req.query.q;
  if (query) {
    const paramName = req.query.query ? 'query' : 'q';
    res.redirect(`/proxy?\${paramName}=\${encodeURIComponent(query)}`);
  } else {
    res.redirect('/');
  }
});

app.listen(port, () => { console.log(`Proxy server running on port \${port}`); });
