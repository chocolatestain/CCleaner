document.addEventListener('DOMContentLoaded', async () => {
  await loadApiKey();
  await loadBlockedComments();

  document.getElementById('saveApiKeyBtn').addEventListener('click', saveApiKey);
  document.getElementById('resetBlockedBtn').addEventListener('click', resetBlockedList);
});

async function loadApiKey() {
  const result = await chrome.storage.local.get(['geminiApiKey']);
  document.getElementById('apiKey').value = result.geminiApiKey || '';
  updateApiStatus(!!result.geminiApiKey);
}

async function saveApiKey() {
  const apiKey = document.getElementById('apiKey').value.trim();
  if (!apiKey) {
    showMessage('API 키를 입력하세요.', 'error');
    updateApiStatus(false);
    return;
  }
  await chrome.storage.local.set({ geminiApiKey: apiKey, quotaExceeded: false });
  // Gemini API 연결 테스트
  try {
    const prompt = `Score 1-10: test\nUser: test`;
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
    });
    const text = await response.text();
    if (!response.ok) {
      if (
        response.status === 429 ||
        text.includes('quota') ||
        text.includes('RESOURCE_EXHAUSTED') ||
        text.includes('You exceeded your current quota')
      ) {
        await chrome.storage.local.set({ quotaExceeded: true });
        showMessage('API 사용량이 소진된 키입니다. 다른 키를 입력하거나, 잠시 후 다시 시도해 주세요.', 'error');
        updateApiStatus(false);
        return;
      }
      showMessage('API 키 연결 테스트 실패: ' + text, 'error');
      updateApiStatus(false);
      return;
    }
    await chrome.storage.local.set({ quotaExceeded: false });
    showMessage('API 키가 정상적으로 저장되었습니다!', 'success');
    updateApiStatus(true);
  } catch (err) {
    showMessage('API 키 연결 테스트 중 오류: ' + err.message, 'error');
    updateApiStatus(false);
  }
}

function updateApiStatus(hasApiKey) {
  const status = document.getElementById('apiStatus');
  if (hasApiKey) {
    status.className = 'status-indicator status-connected';
    status.textContent = '연결됨';
  } else {
    status.className = 'status-indicator status-disconnected';
    status.textContent = '미입력';
  }
}

async function loadBlockedComments() {
  const result = await chrome.storage.local.get(['blockedComments']);
  const blocked = result.blockedComments || [];
  const tbody = document.getElementById('blockedTableBody');
  tbody.innerHTML = '';
  if (blocked.length === 0) {
    document.getElementById('blockedTable').style.display = 'none';
    document.getElementById('emptyBlockedMsg').style.display = 'block';
    return;
  }
  document.getElementById('blockedTable').style.display = '';
  document.getElementById('emptyBlockedMsg').style.display = 'none';
  blocked.slice().reverse().forEach((item, idx) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="comment-cell">${escapeHtml(item.text)}</td>
      <td title="${escapeHtml(item.username)}">${escapeHtml(item.username)}</td>
      <td title="${escapeHtml(item.channelId)}">${escapeHtml(item.channelId)}</td>
      <td class="video-link-cell">${item.videoUrl ? `<a href="${escapeHtml(item.videoUrl)}" target="_blank">${escapeHtml(item.videoUrl)}</a>` : '-'}</td>
      <td>${formatDate(item.timestamp)}</td>
      <td><button data-idx="${blocked.length - 1 - idx}" class="unblockBtn">차단 해제</button></td>
    `;
    tbody.appendChild(tr);
  });
  document.querySelectorAll('.unblockBtn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const idx = parseInt(e.target.getAttribute('data-idx'));
      blocked.splice(idx, 1);
      await chrome.storage.local.set({ blockedComments: blocked });
      showMessage('차단이 해제되었습니다!');
      loadBlockedComments();
    });
  });
}

async function resetBlockedList() {
  if (!confirm('차단 목록을 모두 초기화할까요?')) return;
  await chrome.storage.local.set({ blockedComments: [] });
  showMessage('차단 목록이 초기화되었습니다!');
  loadBlockedComments();
}

function showMessage(msg, type = 'success') {
  const div = document.createElement('div');
  let errorCode = '';
  // 에러 메시지에서 주요 코드만 추출
  try {
    const match = msg.match(/API_KEY_INVALID|INVALID_ARGUMENT|RESOURCE_EXHAUSTED|PERMISSION_DENIED|QUOTA_EXCEEDED/);
    if (match) errorCode = match[0];
  } catch {}
  if (errorCode) {
    msg = `API 키 연결 테스트 실패 : ${errorCode}`;
  }
  div.textContent = msg;
  div.style.cssText = `
    position: fixed; top: 10px; right: 10px; padding: 10px;
    background: ${type === 'success' ? '#4CAF50' : '#f44336'};
    color: white; border-radius: 8px; z-index: 1000; font-size: 13px; max-width: 250px;
    opacity: 0; transform: translateY(-30px); transition: opacity 0.4s, transform 0.4s;`;
  document.body.appendChild(div);
  setTimeout(() => {
    div.style.opacity = '1';
    div.style.transform = 'translateY(0)';
  }, 10);
  setTimeout(() => {
    div.style.opacity = '0';
    div.style.transform = 'translateY(-30px)';
    setTimeout(() => div.remove(), 400);
  }, 2500);
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, function(m) {
    return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','\'':'&#39;'})[m];
  });
}

function formatDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleString('ko-KR');
} 