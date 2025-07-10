console.log('프로그램 실행완료');

class YouTubeCommentCleaner {
  constructor() {
    this.isEnabled = true;
    this.geminiApiKey = '';
    this.processedComments = new Set();
    this.blockedChannels = new Set();
    this.blockedCommentsCount = 0;
    this.apiCache = new Map();
    this.consoleLogEnabled = false;
    this.init();
  }

  async init() {
    this.log('익스텐션 초기화 시작');
    
    // 설정 및 차단 목록 로드
    await this.loadSettings();
    await this.loadBlockedChannels();
    
    // 메시지 리스너 추가
    this.addMessageListener();
    
    // storage 변경 감지 리스너 추가
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.isEnabled) {
        this.isEnabled = changes.isEnabled.newValue !== false;
        if (this.isEnabled) {
          this.observeComments();
        } else {
          this.toggleHiddenComments(false);
        }
        this.updateToggleUI && this.updateToggleUI();
        this.log('storage 변경 감지: isEnabled =', this.isEnabled);
      }
    });
    
    // consoleLogEnabled 설정 불러오기
    const { consoleLogEnabled } = await chrome.storage.local.get(['consoleLogEnabled']);
    this.consoleLogEnabled = consoleLogEnabled === true;
    window.__YACC_LOG_ENABLED = this.consoleLogEnabled;
    // consoleLogEnabled 설정 변경 리스너
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.consoleLogEnabled) {
        this.consoleLogEnabled = changes.consoleLogEnabled.newValue === true;
        window.__YACC_LOG_ENABLED = this.consoleLogEnabled;
      }
    });
    
    // 댓글 섹션 감지 및 처리
    if (!this.geminiApiKey) {
      // API 키 없으면 배지 추가 후 분석 중단
      showFloatingBanner('Gemini API 키가 필요합니다. 옵션에서 입력해 주세요!', 'error');
      return; // 분석 중단
    }
    // quotaExceeded 상태면 배너 표시
    chrome.storage.local.get(['quotaExceeded']).then(({ quotaExceeded }) => {
      if (quotaExceeded) {
        showFloatingBanner('Gemini API 사용량이 모두 소진되었습니다.', 'warning');
      }
    });
    this.observeComments();
    
    this.log('익스텐션 초기화 완료');
  }

  async loadSettings() {
    try {
      const result = await chrome.storage.local.get(['isEnabled', 'geminiApiKey', 'blockedCommentsCount']);
      this.isEnabled = result.isEnabled !== false;
      this.geminiApiKey = result.geminiApiKey || '';
      this.blockedCommentsCount = result.blockedCommentsCount || 0;
      this.log('설정 로드됨:', { 
        isEnabled: this.isEnabled, 
        hasApiKey: !!this.geminiApiKey,
        blockedCount: this.blockedCommentsCount
      });
    } catch (error) {
      this.log('설정 로드 실패, 기본값 사용');
      this.isEnabled = true;
      this.geminiApiKey = '';
      this.blockedCommentsCount = 0;
    }
  }

  async loadBlockedChannels() {
    try {
      const result = await chrome.storage.local.get(['blockedChannels']);
      if (result.blockedChannels) {
        // 1주일이 지난 차단 목록 정리
        const oneWeekAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
        const validChannels = {};
        
        Object.entries(result.blockedChannels).forEach(([channelId, data]) => {
          if (data.timestamp > oneWeekAgo) {
            validChannels[channelId] = data;
            this.blockedChannels.add(channelId);
          }
        });
        
        // 정리된 목록 저장
        await chrome.storage.local.set({ blockedChannels: validChannels });
        this.log('차단된 채널 로드됨:', this.blockedChannels.size, '개');
      }
    } catch (error) {
      this.log('차단된 채널 로드 실패:', error);
    }
  }

  addMessageListener() {
    if (this._messageListenerRegistered) return;
    this._messageListenerRegistered = true;
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
      if (request.action === 'showFloatingBanner') {
        showFloatingBanner(request.message, request.type);
        this.log('showFloatingBanner 실행', request.message, request.type);
        return true;
      }
      if (request.action === 'setFilterEnabled') {
        this.isEnabled = request.isEnabled;
        if (this.isEnabled) {
          this.observeComments();
        } else {
          this.toggleHiddenComments(false);
        }
        this.updateToggleUI && this.updateToggleUI();
        return true;
      }
      switch (request.action) {
        case 'settingsUpdated':
          this.handleSettingsUpdate(request);
          break;
        case 'statsReset':
          this.handleStatsReset();
          break;
        default:
          this.log('request.action 오류 발생:', request.action);
      }
      return true;
    });
  }

  async handleSettingsUpdate(request) {
    this.log('설정 업데이트 처리:', request);
    
    this.isEnabled = request.isEnabled;
    this.geminiApiKey = request.geminiApiKey;
    
    // UI 업데이트
    this.updateToggleUI();
    
    // 숨겨진 댓글들 토글
    this.toggleHiddenComments();
  }

  async handleStatsReset() {
    this.log('통계 초기화 처리');
    
    this.blockedCommentsCount = 0;
    this.blockedChannels.clear();
    
    // 숨겨진 댓글들 표시
    const hiddenComments = document.querySelectorAll('.ai-comment-badge');
    hiddenComments.forEach(badge => {
      const comment = badge.parentElement;
      if (comment) {
        comment.style.display = 'block';
        badge.remove();
      }
    });
    
    // UI 업데이트
    this.updateToggleUI();
  }

  observeComments() {
    if (!this.isEnabled) return;
    this.log('댓글 감지 시작');
    
    // 초기 댓글 처리
    this.processExistingComments();
    
    const observer = new MutationObserver((mutations) => {
      if (!this.isEnabled) return;
      
      let hasNewComments = false;
      
      mutations.forEach((mutation) => {
        mutation.addedNodes.forEach((node) => {
          if (node.nodeType === Node.ELEMENT_NODE) {
            if (this.isCommentElement(node) || this.hasCommentChildren(node)) {
              hasNewComments = true;
            }
          }
        });
      });
      
      if (hasNewComments) {
        this.log('새로운 댓글 감지됨');
        setTimeout(() => this.processExistingComments(), 100);
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true
    });
  }

  isCommentElement(element) {
    return element.matches && (
      element.matches('ytd-comment-thread-renderer') ||
      element.matches('ytd-comment-renderer') ||
      element.matches('#content-text')
    );
  }

  hasCommentChildren(element) {
    return element.querySelector && (
      element.querySelector('ytd-comment-thread-renderer') ||
      element.querySelector('ytd-comment-renderer') ||
      element.querySelector('#content-text')
    );
  }

  processExistingComments() {
    if (!this.isEnabled) return;
    this.log('기존 댓글 처리 시작');

    const commentSelectors = [
      'ytd-comment-thread-renderer',
      'ytd-comment-renderer',
      '#content-text'
    ];

    let totalComments = 0;
    
    commentSelectors.forEach(selector => {
      const comments = document.querySelectorAll(selector);
      this.log(`"${selector}"로 ${comments.length}개 댓글 발견`);
      
      comments.forEach(comment => {
        if (!this.processedComments.has(comment)) {
          this.processedComments.add(comment);
          this.analyzeComment(comment);
          totalComments++;
        }
      });
    });
    
    this.log(`총 ${totalComments}개 새 댓글 처리됨`);
  }

  async analyzeComment(commentElement) {
    if (!this.isEnabled) return;
    try {
      // 댓글 정보 추출
      const commentInfo = this.extractCommentInfo(commentElement);
      if (!commentInfo) return;

      this.log('댓글 분석 시작:', {
        text: commentInfo.text.substring(0, 30) + '...',
        username: commentInfo.username,
        likes: commentInfo.likes,
        channelId: commentInfo.channelId
      });

      // 1. 좋아요 수 체크 (200개 미만이면 스킵)
      if (commentInfo.likes < 200) {
        return;
      }

      // 2. 차단된 채널 체크
      if (this.blockedChannels.has(commentInfo.channelId)) {
        this.log(`차단된 채널의 댓글 즉시 차단: ${commentInfo.username} (${commentInfo.channelId})`);
        this.hideComment(commentElement, commentInfo);
        return;
      }

      // 3. 사전 필터링 점수 계산
      const preFilterScore = this.detectAndScoreAIConditions(commentInfo);

      // 4. Gemini API 호출 (점수가 0보다 클 때만)
      if (preFilterScore > 0) {
        const aiScore = await this.callGeminiAPI(commentInfo);
        const finalScore = preFilterScore + aiScore;
        
        // 임계값 (예: 3점 이상이면 AI로 판정)
        if (finalScore >= 3) {
          this.log(`AI 댓글 차단: ${commentInfo.username} - "${commentInfo.text.substring(0, 50)}..." (점수: ${finalScore})`);
          this.hideComment(commentElement, commentInfo);
          await this.blockChannel(commentInfo.channelId);
        }
      }
    } catch (error) {
      this.error('댓글 분석 중 오류:', error);
    }
  }

  extractCommentInfo(commentElement) {
    try {
      // 댓글 텍스트 추출 (더 강력한 선택자)
      const textSelectors = [
        '#content-text',
        '.ytd-comment-renderer #content-text',
        '.ytd-comment-thread-renderer #content-text',
        'span[dir="auto"]',
        '.style-scope.ytd-comment-renderer'
      ];

      let textElement = null;
      for (const selector of textSelectors) {
        textElement = commentElement.querySelector(selector);
        if (textElement && textElement.textContent.trim()) {
          break;
        }
      }

      if (!textElement) {
        // 직접 텍스트가 있는 경우
        if (commentElement.textContent && commentElement.textContent.trim().length > 10) {
          textElement = commentElement;
        } else {
          return null;
        }
      }
      
      const text = textElement.textContent.trim();
      if (!text || text.length < 10) return null;

      // 사용자명 추출 (더 강력한 선택자)
      const usernameSelectors = [
        '#author-text span',
        '#author-text a',
        'a#author-text',
        '.ytd-comment-renderer #author-text',
        '.ytd-comment-thread-renderer #author-text'
      ];

      let usernameElement = null;
      for (const selector of usernameSelectors) {
        usernameElement = commentElement.querySelector(selector);
        if (usernameElement) break;
      }

      const username = usernameElement ? usernameElement.textContent.trim() : '';

      // 좋아요 수 추출 (개선된 선택자)
      const likes = this.extractLikeCount(commentElement);

      // 채널 ID 추출
      const channelLink = commentElement.querySelector('#author-text a, a#author-text');
      const channelId = channelLink ? this.extractChannelId(channelLink.href) : '';

      // 글꼴 Bold 체크
      const isBold = textElement.style.fontWeight === '500' || 
                    window.getComputedStyle(textElement).fontWeight === '500';

      return {
        text,
        username,
        likes,
        channelId,
        isBold,
        element: commentElement
      };
    } catch (error) {
      this.error('댓글 정보 추출 실패:', error);
      return null;
    }
  }

  extractLikeCount(commentElement) {
    // 좋아요 수 추출을 위한 다양한 선택자
    const likeSelectors = [
      // 기본 좋아요 수 선택자들
      '#vote-count-middle',
      '#vote-count-left',
      '.vote-count',
      '.style-scope.ytd-comment-renderer #vote-count-middle',
      
      // 더 구체적인 선택자들
      'ytd-comment-renderer #vote-count-middle',
      'ytd-comment-thread-renderer #vote-count-middle',
      
      // aria-label을 사용한 선택자
      '[aria-label*="좋아요"]',
      '[aria-label*="like"]',
      
      // 버튼 내부의 텍스트
      'ytd-toggle-button-renderer #text',
      'ytd-toggle-button-renderer .style-scope.ytd-toggle-button-renderer'
    ];

    for (const selector of likeSelectors) {
      const element = commentElement.querySelector(selector);
      if (element) {
        const text = element.textContent.trim();
        const likes = this.parseLikeCount(text);
        if (likes > 0) {
          this.log(`좋아요 수 발견 (${selector}):`, text, '->', likes);
          return likes;
        }
      }
    }

    // 부모 요소에서도 찾기
    const parentElement = commentElement.parentElement;
    if (parentElement) {
      for (const selector of likeSelectors) {
        const element = parentElement.querySelector(selector);
        if (element) {
          const text = element.textContent.trim();
          const likes = this.parseLikeCount(text);
          if (likes > 0) {
            this.log(`좋아요 수 발견 (부모 ${selector}):`, text, '->', likes);
            return likes;
          }
        }
      }
    }

    this.log('좋아요 수를 찾을 수 없음');
    return 0;
  }

  parseLikeCount(likesText) {
    if (!likesText) return 0;
    
    const text = likesText.toLowerCase().trim();
    this.log('좋아요 텍스트 파싱:', text);
    
    // 숫자만 있는 경우
    const numberMatch = text.match(/^(\d+)$/);
    if (numberMatch) return parseInt(numberMatch[1]);
    
    // K 단위 (예: 1.2K, 1K)
    const kMatch = text.match(/^(\d+(?:\.\d+)?)k$/);
    if (kMatch) return Math.floor(parseFloat(kMatch[1]) * 1000);
    
    // M 단위 (예: 1.5M, 1M)
    const mMatch = text.match(/^(\d+(?:\.\d+)?)m$/);
    if (mMatch) return Math.floor(parseFloat(mMatch[1]) * 1000000);
    
    // 천 단위 구분자 (예: 1,234)
    const commaMatch = text.match(/^(\d{1,3}(?:,\d{3})*)$/);
    if (commaMatch) return parseInt(commaMatch[1].replace(/,/g, ''));
    
    // 한국어 단위 (예: 1.2천, 1천)
    const koreanKMatch = text.match(/^(\d+(?:\.\d+)?)천$/);
    if (koreanKMatch) return Math.floor(parseFloat(koreanKMatch[1]) * 1000);
    
    // 한국어 만 단위 (예: 1.2만, 1만)
    const koreanMMatch = text.match(/^(\d+(?:\.\d+)?)만$/);
    if (koreanMMatch) return Math.floor(parseFloat(koreanMMatch[1]) * 10000);
    
    return 0;
  }

  extractChannelId(href) {
    if (!href) return '';
    
    // /channel/UC... 형태에서 추출
    const channelMatch = href.match(/\/channel\/(UC[a-zA-Z0-9_-]+)/);
    if (channelMatch) return channelMatch[1];
    
    // /c/ 또는 /@ 형태에서 추출 (핸들)
    const handleMatch = href.match(/\/(?:c\/|@)([^\/]+)/);
    if (handleMatch) return handleMatch[1];
    
    return '';
  }

  detectAndScoreAIConditions(commentInfo) {
    let score = 0;
    const text = commentInfo.text || '';
    const username = commentInfo.username || '';

    // 1. 글꼴 Bold 체크
    if (commentInfo.isBold) {
      score += 1;
      this.log('Bold 글꼴 감지: +1점');
    }

    // 2. 좋아요 수 체크 (300개 이상)
    if (commentInfo.likes >= 300) {
      score += 1;
      this.log('높은 좋아요 수 감지: +1점');
    }

    // 3. 사용자명 패턴 체크
    const usernamePattern = /채널|channel|체널|체날|채날/gi;
    if (usernamePattern.test(username)) {
      score += 1;
      this.log('채널 변형 단어 감지: +1점');
    }

    // 숫자 19 변형 패턴 (I9, i9, l9, I_9, i_9, l_9)
    const nineteenPattern = /[IiLl]9|[IiLl]_9/;
    if (nineteenPattern.test(username)) {
      score += 1;
      this.log('19 변형 패턴 감지: +1점');
    }

    // 언더바 2개 이상
    const underscoreCount = (username.match(/_/g) || []).length;
    if (underscoreCount >= 2) {
      score += 1;
      this.log('언더바 2개 이상 감지: +1점');
    }

    return score;
  }

  async callGeminiAPI(commentInfo) {
    const cacheKey = `${commentInfo.text}::${commentInfo.username}`;
    if (this.apiCache.has(cacheKey)) {
      return this.apiCache.get(cacheKey);
    }
    if (!this.geminiApiKey) {
      console.warn('Gemini API 키가 설정되지 않았습니다.');
      return 0;
    }
    try {
      // 프롬프트 개선
      const prompt = `Score 1-10 If this comment is written by AI: ${commentInfo.text}\nUser: ${commentInfo.username}`;
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${this.geminiApiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }]
        })
      });
      if (!response.ok) {
        const errorText = await response.text();
        if (
          response.status === 429 ||
          errorText.includes('quota') ||
          errorText.includes('RESOURCE_EXHAUSTED') ||
          errorText.includes('You exceeded your current quota')
        ) {
          chrome.runtime.sendMessage({ action: 'geminiQuotaExceeded' });
          if (this.geminiApiKey) {
            chrome.storage.local.set({ quotaExceeded: true });
          }
          showFloatingBanner('Gemini API 사용량이 모두 소진되었습니다.', 'warning');
        }
        throw new Error(`API 응답 오류: ${response.status} - ${errorText}`);
      }
      const data = await response.json();
      const result = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
      const score = parseInt(result) || 0;
      const clamped = Math.min(Math.max(score, 1), 10);
      this.apiCache.set(cacheKey, clamped);
      return clamped;
    } catch (error) {
      this.error('Gemini 2.0 Flash API 호출 실패:', error);
      return 0;
    }
  }

  async hideComment(commentElement, commentInfo) {
    // 댓글 숨김 처리
    commentElement.style.display = 'none';
    
    // 차단된 댓글 카운터 증가
    this.blockedCommentsCount++;
    
    // 차단된 댓글 정보 저장
    const blockedComment = {
      text: commentInfo.text,
      username: commentInfo.username,
      channelId: commentInfo.channelId,
      videoUrl: window.location.href,
      timestamp: Date.now()
    };
    
    try {
      const result = await chrome.storage.local.get(['blockedComments']);
      const blockedComments = result.blockedComments || [];
      blockedComments.push(blockedComment);
      
      // 최근 100개만 유지
      if (blockedComments.length > 100) {
        blockedComments.splice(0, blockedComments.length - 100);
      }
      
      await chrome.storage.local.set({ 
        blockedCommentsCount: this.blockedCommentsCount,
        blockedComments: blockedComments
      });
    } catch (error) {
      this.error('차단된 댓글 저장 실패:', error);
    }
    
    this.log(`댓글 차단 완료: ${commentInfo.username} - "${commentInfo.text.substring(0, 30)}..."`);
  }

  async blockChannel(channelId) {
    if (!channelId) return;
    
    try {
      const blockedChannels = {};
      const result = await chrome.storage.local.get(['blockedChannels']);
      
      if (result.blockedChannels) {
        Object.assign(blockedChannels, result.blockedChannels);
      }
      
      blockedChannels[channelId] = {
        timestamp: Date.now()
      };
      
      await chrome.storage.local.set({ blockedChannels });
      this.blockedChannels.add(channelId);
      
      this.log('채널 차단됨:', channelId);
    } catch (error) {
      this.error('채널 차단 실패:', error);
    }
  }
  findCommentSection() {
    // 다양한 댓글 섹션 선택자 시도
    const selectors = [
      '#comments',
      '#comments #contents',
      'ytd-comments#comments',
      '#below',
      '#below #contents',
      'ytd-watch-flexy #below'
    ];
    
    for (const selector of selectors) {
      const element = document.querySelector(selector);
      if (element) {
        this.log(`댓글 섹션 발견: ${selector}`);
        return element;
      }
    }
    
    return null;
  }

  updateToggleUI() {
    const toggleButton = document.getElementById('ai-filter-toggle');
    if (toggleButton) {
      const button = toggleButton.querySelector('#ai-toggle-btn');
      if (button) {
        button.style.background = this.isEnabled ? '#4CAF50' : '#f44336';
      }
      
      const statusText = toggleButton.querySelector('div:last-child');
      if (statusText) {
        statusText.textContent = `차단된 댓글: ${this.blockedCommentsCount}개 | 
        <a href="#" id="view-blocked" style="color: #2196F3; text-decoration: none;">차단 목록 보기</a>`;
      }
    }
  }

  log(...args) { if (this.consoleLogEnabled) console.log(...args); }
  warn(...args) { if (this.consoleLogEnabled) console.warn(...args); }
  error(...args) { if (this.consoleLogEnabled) console.error(...args); }
}

function showFloatingBanner(message, type = 'info') {
  if (document.getElementById('floatingBanner')) return;
  const banner = document.createElement('div');
  banner.id = 'floatingBanner';
  banner.textContent = message;
  banner.style.cssText = `
    position: fixed; top: 0; left: 50%; transform: translateX(-50%) translateY(-100%);
    z-index: 2147483647; padding: 14px 32px; border-radius: 12px;
    font-size: 16px; font-weight: bold; color: #fff;
    background: ${type === 'success' ? '#4CAF50' : type === 'error' ? '#f44336' : '#ff9800'};
    box-shadow: 0 2px 12px rgba(0,0,0,0.12);
    opacity: 0; transition: transform 0.4s cubic-bezier(.4,2,.6,1), opacity 0.4s; pointer-events: none;`;
  document.body.appendChild(banner);
  setTimeout(() => {
    banner.style.transform = 'translateX(-50%) translateY(0)';
    banner.style.opacity = '0.97';
  }, 10);
  setTimeout(() => {
    banner.style.transform = 'translateX(-50%) translateY(-100%)';
    banner.style.opacity = '0';
    setTimeout(() => banner.remove(), 400);
  }, 3000);
}

// 익스텐션 초기화
console.log('Comment Cleaner 시작');
new YouTubeCommentCleaner(); 