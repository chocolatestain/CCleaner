document.addEventListener('DOMContentLoaded', async () => {
  console.log('팝업 로드됨');
  
  // 설정 로드
  try {
    const result = await chrome.storage.local.get([
      'isEnabled', 
      'consoleLogEnabled',
      'blockedCommentsCount',
      'blockedChannels',
      'geminiApiKey',
      'quotaExceeded'
    ]);
    document.getElementById('filterToggle').checked = result.isEnabled !== false;
    document.getElementById('consoleLogToggle').checked = result.consoleLogEnabled === true;
    updateStats(result);
    if (!result.geminiApiKey) {
      showApiKeyBanner();
    } else if (result.quotaExceeded) {
      showQuotaBanner();
    }
  } catch (error) {
    document.getElementById('filterToggle').checked = true;
    document.getElementById('consoleLogToggle').checked = false;
    updateStats({});
    showApiKeyBanner();
  }
  
  // 이벤트 리스너
  const filterToggle = document.getElementById('filterToggle');
  const onoffLabel = document.getElementById('onoffLabel');
  function updatePowerLabel() {
    onoffLabel.textContent = filterToggle.checked ? 'ON' : 'OFF';
  }
  filterToggle.addEventListener('change', async () => {
    const isEnabled = filterToggle.checked;
    await chrome.storage.local.set({ isEnabled });
  });
  document.addEventListener('DOMContentLoaded', () => {
    updatePowerLabel();
  });
  document.getElementById('viewBlockedBtn').addEventListener('click', () => {
    if (chrome.runtime.openOptionsPage) {
      chrome.runtime.openOptionsPage();
    } else {
      window.open(chrome.runtime.getURL('options.html'));
    }
  });
  const consoleLogToggle = document.getElementById('consoleLogToggle');
  consoleLogToggle.addEventListener('change', async () => {
    const consoleLogEnabled = consoleLogToggle.checked;
    await chrome.storage.local.set({ consoleLogEnabled });
  });
});

function updateStats(data) {
  const blockedComments = data.blockedCommentsCount || 0;
  document.getElementById('blockedComments').textContent = blockedComments;
}

async function saveSettings() {
  const isEnabled = document.getElementById('filterToggle').checked;
  await chrome.storage.local.set({ isEnabled: isEnabled });
  showMessage('설정이 저장되었습니다!');
}

function showApiKeyBanner() {
  if (document.getElementById('apiKeyBanner')) return;
  const banner = document.createElement('div');
  banner.id = 'apiKeyBanner';
  banner.textContent = 'Gemini API 키가 필요합니다. 옵션에서 입력해 주세요!';
  banner.style.cssText = `
    background: #f44336; color: white; padding: 10px; border-radius: 6px;
    text-align: center; margin-bottom: 12px; font-size: 13px; font-weight: bold;`;
  const header = document.querySelector('.header');
  header.parentNode.insertBefore(banner, header.nextSibling);
}

function showQuotaBanner() {
  if (document.getElementById('quotaBanner')) return;
  const banner = document.createElement('div');
  banner.id = 'quotaBanner';
  banner.textContent = 'Gemini API 사용량이 모두 소진되었습니다. 옵션에서 API 키를 확인하거나, 잠시 후 다시 시도해 주세요!';
  banner.style.cssText = `
    background: #ff9800; color: white; padding: 10px; border-radius: 6px;
    text-align: center; margin-bottom: 12px; font-size: 13px; font-weight: bold;`;
  const header = document.querySelector('.header');
  header.parentNode.insertBefore(banner, header.nextSibling);
}

function showMessage(message, type = 'success') {
  const messageDiv = document.createElement('div');
  messageDiv.textContent = message;
  messageDiv.style.cssText = `
    position: fixed;
    top: 10px;
    right: 10px;
    padding: 10px;
    background: ${type === 'success' ? '#4CAF50' : '#f44336'};
    color: white;
    border-radius: 4px;
    z-index: 1000;
    font-size: 12px;
    max-width: 250px;
  `;
  
  document.body.appendChild(messageDiv);
  
  setTimeout(() => {
    messageDiv.remove();
  }, 3000);
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'geminiQuotaExceeded') {
    chrome.storage.local.get(['geminiApiKey']).then(({ geminiApiKey }) => {
      if (geminiApiKey) {
        showQuotaBanner();
        chrome.storage.local.set({ quotaExceeded: true });
      }
    });
  }
}); 