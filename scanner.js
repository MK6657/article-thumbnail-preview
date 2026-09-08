(function () {
  'use strict';

  var EXCLUDE_URL_PATTERNS = [
    '/login','/signup','/register','/logout','/search','/tag/','/category/','/author/',
    '/user/','/profile','/admin','/wp-admin','/feed','/rss','/api/','/cdn-cgi/',
    '/assets/','/static/','/dist/','.pdf','.zip','.doc','.xls','.mp3','.mp4','.avi',
    '#comment','#reply','javascript:','spacecp','space-uid','mod=space','mod=logging',
    'mod=task','mod=guide','&view=admin','mod=admin','/misc.php','/member.php',
    'mod=stats','/favicon.','/robots.txt','/sitemap','portal.php'
  ];
  var EXCLUDE_DOMAIN_RE = /https?:\/\/[^\/]*(?:qnldvn|discuz)\.(?:com|net|org)/;
  var EXCLUDE_FORUM_INDEX_RE = /forum-\d+-\d+\.html/;
  var EXCLUDE_THREAD_RE = /thread-\d+/;
  var EXCLUDE_FORUMDISPLAY_RE = /forumdisplay/;
  var EXCLUDE_FILTER_TYPEID_RE = /filter=typeid/;
  var SERVICE_THREAD_KEYWORDS = ['公告','版务','必看','规则','服务大厅','议事大厅','通知与教程','发帖须知','新人必看','问题专贴','禁止单独开帖','举报','投诉','申诉','邀请码','发布器','白名单','APP下载','安卓APP','最新网址'];
  var SERVICE_THREAD_KEYWORDS_RE = new RegExp(SERVICE_THREAD_KEYWORDS.join('|'));

  var ARTICLE_CONTAINER_SELECTORS = [
    'tbody[id^="normalthread"]',
    'tbody[id^="stickthread"]',
    'tbody[id^="thread"]',
    'tr[id^="thread"]',
    '.threadlist tbody[id]',
    'table[id*="threadlist"] tbody',
    'form table tbody'
  ];
  var PRIMARY_THREAD_CONTAINER_SELECTORS = [
    '#threadlist'
  ];
  var HIGH_CONFIDENCE_THREAD_CONTAINER_SELECTORS = [
    '.threadlist',
    'table[id*="threadlist"]',
    'form[id*="moderate"]'
  ];
  var BROAD_THREAD_CONTAINER_SELECTORS = [
    '.bm_c',
    '[id*="forum"]',
    '[id*="thread"]'
  ];
  var ARTICLE_SCAN_NODE_BUDGET = 120;
  var ARTICLE_VIEWPORT_SEEK_BACKTRACK = 8;

  function createScanContext() {
    return {
      separatorByTable: typeof WeakMap !== 'undefined' ? new WeakMap() : null
    };
  }

  function resetArticleScanState(scanState, root, skipServiceThreads) {
    scanState.root = root;
    scanState.selectorIndex = 0;
    scanState.nodeIndex = 0;
    scanState.nodes = null;
    scanState.seen = new Set();
    scanState.context = createScanContext();
    scanState.skipServiceThreads = skipServiceThreads;
    scanState.exhausted = false;
  }

  function getReusableScanRoot(scanState) {
    var root = scanState && scanState.root;
    if (!root || !root.querySelectorAll) return null;
    if (root === document) return root;
    if (typeof document.contains !== 'function' || !document.contains(root)) return null;
    return root;
  }

  function getViewportSeekStartIndex(nodes, viewportTop) {
    if (!nodes || !nodes.length || typeof viewportTop !== 'number' || !isFinite(viewportTop)) return 0;
    var measured = false;
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      if (!node || typeof node.getBoundingClientRect !== 'function') continue;
      var rect = node.getBoundingClientRect();
      if (!rect || typeof rect.bottom !== 'number') continue;
      measured = true;
      if (rect.bottom >= viewportTop) return Math.max(0, i - ARTICLE_VIEWPORT_SEEK_BACKTRACK);
    }
    return measured ? Math.max(0, nodes.length - 1 - ARTICLE_VIEWPORT_SEEK_BACKTRACK) : 0;
  }

  function findArticleLink(tbody) {
    if (!tbody || !tbody.querySelector) return null;
    var selectors = [
      '.icn a[href]',
      'a.xst[href]',
      'th a[href*="thread"]',
      'a[href*="thread-"]'
    ];
    for (var i = 0; i < selectors.length; i++) {
      var link = tbody.querySelector(selectors[i]);
      if (isUsableThreadLink(link)) return link;
    }
    return null;
  }

  function isUsableThreadLink(link) {
    if (!link || !link.href) return false;
    if (link.href.indexOf('javascript:') === 0 || link.href === '#') return false;
    return !(link.closest && link.closest('nav, footer, header'));
  }

  function isDecoratedArticleContainer(container) {
    if (!container) return false;
    if (container.classList && container.classList.contains('atp-processed')) return true;
    if (container.querySelector && container.querySelector('.atp-thumbnail-container,.atp-thumb-row')) return true;
    if (
      container.tagName === 'TR' &&
      container.nextElementSibling &&
      container.nextElementSibling.classList &&
      container.nextElementSibling.classList.contains('atp-thumb-row')
    ) return true;
    if (container.tagName === 'TR') {
      var parent = container.parentElement;
      if (parent && parent.tagName === 'TBODY') {
        if (parent.classList && parent.classList.contains('atp-processed')) return true;
        if (parent.querySelector && parent.querySelector('.atp-thumbnail-container,.atp-thumb-row')) return true;
      }
    }
    return false;
  }

  function hasArticleCandidate(root) {
    if (!root) return false;
    for (var i = 0; i < ARTICLE_CONTAINER_SELECTORS.length; i++) {
      var selector = ARTICLE_CONTAINER_SELECTORS[i];
      var row = null;
      if (root.matches && root.matches(selector)) row = root;
      else if (root.querySelector) row = root.querySelector(selector);
      if (isUsableThreadLink(findArticleLink(row))) return true;
    }
    return false;
  }

  // 全文档没有任何候选行元素时，任何子树都不可能有候选：一次性短路掉后面五轮扫描
  // （首页/帖内页/搜索页每次重试都要跑 11 次 document 级查询 + 上千次子树查询）
  function documentHasArticleRow() {
    for (var i = 0; i < ARTICLE_CONTAINER_SELECTORS.length; i++) {
      if (document.querySelector(ARTICLE_CONTAINER_SELECTORS[i])) return true;
    }
    return false;
  }

  function findFirstThreadContainer(selectors, requireCandidate) {
    for (var i = 0; i < selectors.length; i++) {
      var roots = document.querySelectorAll(selectors[i]);
      for (var j = 0; j < roots.length; j++) {
        if (!requireCandidate || hasArticleCandidate(roots[j])) return roots[j];
      }
    }
    return null;
  }

  var ATPScanner = {
    hasArticleCandidate: function(root) {
      return hasArticleCandidate(root);
    },

    findThreadContainer: function(requireCandidate) {
      if (!documentHasArticleRow()) return null;
      var found = findFirstThreadContainer(PRIMARY_THREAD_CONTAINER_SELECTORS, true) ||
        findFirstThreadContainer(HIGH_CONFIDENCE_THREAD_CONTAINER_SELECTORS, true) ||
        findFirstThreadContainer(BROAD_THREAD_CONTAINER_SELECTORS, true);
      // 调用方要求带候选（setupObserver）时后两轮是可证明的死工作：
      // 前两轮已用同一 hasArticleCandidate 判过，无候选兜底返回的容器必被调用方拒绝
      if (found || requireCandidate) return found;
      return findFirstThreadContainer(PRIMARY_THREAD_CONTAINER_SELECTORS, false) ||
        findFirstThreadContainer(HIGH_CONFIDENCE_THREAD_CONTAINER_SELECTORS, false);
    },

    shouldExcludeUrl: function(url) {
      var L = url.toLowerCase();
      for (var i = 0; i < EXCLUDE_URL_PATTERNS.length; i++) {
        if (L.indexOf(EXCLUDE_URL_PATTERNS[i]) !== -1) return true;
      }
      if (L.match(EXCLUDE_DOMAIN_RE)) return true;
      if (EXCLUDE_FORUM_INDEX_RE.test(L) && !EXCLUDE_THREAD_RE.test(L)) return true;
      if (EXCLUDE_FORUMDISPLAY_RE.test(L)) return true;
      if (EXCLUDE_FILTER_TYPEID_RE.test(L)) return true;
      return false;
    },

    isArticlePageUrl: function(url) {
      return /thread-\d+/.test(url.toLowerCase()) || /mod=viewthread/.test(url.toLowerCase());
    },

    isDecoratedArticleContainer: isDecoratedArticleContainer,

    getSeparatorForTable: function(table, context) {
      if (!table) return document.querySelector('tbody#separatorline');
      if (!context || !context.separatorByTable) return table.querySelector('tbody#separatorline');
      if (!context.separatorByTable.has(table)) {
        context.separatorByTable.set(table, table.querySelector('tbody#separatorline') || null);
      }
      return context.separatorByTable.get(table);
    },

    isForumServiceThread: function(tbody, link, context) {
      var id = tbody.id || '';
      if (/^stickthread_\d+/.test(id)) return true;

      var table = tbody.closest ? tbody.closest('table') : null;
      var separator = ATPScanner.getSeparatorForTable(table, context);
      if (separator && tbody.compareDocumentPosition) {
        if (tbody.compareDocumentPosition(separator) & Node.DOCUMENT_POSITION_FOLLOWING) return true;
      }

      var titleEl = tbody.querySelector ? tbody.querySelector('a.xst') : null;
      var title = titleEl ? titleEl.textContent : (link ? link.textContent : '');
      if (SERVICE_THREAD_KEYWORDS_RE.test(title)) return true;
      return SERVICE_THREAD_KEYWORDS_RE.test((tbody.textContent || '').substring(0, 300));
    },

    detectArticleContainers: function(options) {
      options = options || {};
      var limit = options.limit || 100;
      var nodeBudget = Math.max(limit, Number(options.nodeBudget) || ARTICLE_SCAN_NODE_BUDGET);
      var accept = typeof options.accept === 'function' ? options.accept : null;
      var skipServiceThreads = options.skipServiceThreads !== false;
      var results = [];
      var scanState = options.scanState && typeof options.scanState === 'object' ? options.scanState : null;
      var root = getReusableScanRoot(scanState);
      if (!root) root = ATPScanner.findThreadContainer() || document;
      if (!root.querySelectorAll) root = document;
      var selectors = ARTICLE_CONTAINER_SELECTORS;
      var seen;
      var context;
      var selectorIndex = 0;
      var nodeIndex = 0;
      var nodes = null;
      var didResetScanState = false;
      if (scanState) {
        if (
          scanState.root !== root ||
          scanState.skipServiceThreads !== skipServiceThreads ||
          scanState.exhausted
        ) {
          resetArticleScanState(scanState, root, skipServiceThreads);
          didResetScanState = true;
        }
        seen = scanState.seen;
        context = scanState.context;
        selectorIndex = scanState.selectorIndex || 0;
        nodeIndex = scanState.nodeIndex || 0;
        nodes = scanState.nodes || null;
      } else {
        seen = new Set();
        context = createScanContext();
      }
      var viewportTop = Number(options.viewportTop);
      var shouldSeekViewportStart = !!(scanState && didResetScanState && options.seekViewportStart && isFinite(viewportTop));
      var scannedNodes = 0;
      for (var i = selectorIndex; i < selectors.length; i++) {
        if (!nodes) nodes = root.matches && root.matches(selectors[i]) ? [root] : root.querySelectorAll(selectors[i]);
        if (shouldSeekViewportStart && nodes && nodes.length) {
          nodeIndex = getViewportSeekStartIndex(nodes, viewportTop);
          shouldSeekViewportStart = false;
        }
        for (var j = i === selectorIndex ? nodeIndex : 0; j < nodes.length; j++) {
          scannedNodes++;
          var tbody = nodes[j];
          if (scanState) {
            scanState.selectorIndex = i;
            scanState.nodeIndex = j + 1;
            scanState.nodes = nodes;
          }
          if (seen.has(tbody)) {
            if (scannedNodes >= nodeBudget) {
              if (scanState) scanState.exhausted = false;
              return results;
            }
            continue;
          }
          seen.add(tbody);
          if (ATPScanner.isDecoratedArticleContainer(tbody)) {
            if (scannedNodes >= nodeBudget) {
              if (scanState) scanState.exhausted = false;
              return results;
            }
            continue;
          }
          var link = findArticleLink(tbody);
          if (isUsableThreadLink(link)) {
            var entry = { container: tbody, link: link };
            if (accept && !accept(entry)) {
              if (scannedNodes >= nodeBudget) {
                if (scanState) scanState.exhausted = false;
                return results;
              }
              continue;
            }
            if (skipServiceThreads && ATPScanner.isForumServiceThread(tbody, link, context)) {
              if (scannedNodes >= nodeBudget) {
                if (scanState) scanState.exhausted = false;
                return results;
              }
              continue;
            }
            results.push(entry);
            if (results.length >= limit) {
              if (scanState) scanState.exhausted = false;
              return results;
            }
          }
          if (scannedNodes >= nodeBudget) {
            if (scanState) scanState.exhausted = false;
            return results;
          }
        }
        nodes = null;
        if (scanState) {
          scanState.selectorIndex = i + 1;
          scanState.nodeIndex = 0;
          scanState.nodes = null;
        }
      }
      if (scanState) scanState.exhausted = true;
      return results;
    }
  };

  window.ATPScanner = ATPScanner;
})();
