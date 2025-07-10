// 백그라운드 서비스 워커
chrome.runtime.onInstalled.addListener(() => {
  console.log('YouTube AI Comment Cleaner 설치됨');
  
  // 기본 설정 초기화
  chrome.storage.local.set({
    isEnabled: true,
    geminiApiKey: '',
    blockedCommentsCount: 0,
    blockedChannels: {}
  });
});

// 주기적으로 차단된 채널 목록 정리 (1주일 만료)
chrome.alarms.create('cleanupBlockedChannels', { periodInMinutes: 60 * 24 }); // 24시간마다

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'cleanupBlockedChannels') {
    try {
      const result = await chrome.storage.local.get(['blockedChannels']);
      if (result.blockedChannels) {
        const oneWeekAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
        const validChannels = {};
        
        Object.entries(result.blockedChannels).forEach(([channelId, data]) => {
          if (data.timestamp > oneWeekAgo) {
            validChannels[channelId] = data;
          }
        });
        
        await chrome.storage.local.set({ blockedChannels: validChannels });
        console.log('차단된 채널 목록 정리 완료');
      }
    } catch (error) {
      console.error('차단된 채널 목록 정리 실패:', error);
    }
  }
}); 