export async function fetchWithRetry(url, options = {}, label = '网络请求') {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(timer);
      return response;
    } catch (error) {
      clearTimeout(timer);
      lastError = error;
      if (attempt < 3) await new Promise(resolve => setTimeout(resolve, attempt * 400));
    }
  }
  const code = lastError?.cause?.code || lastError?.code || '';
  const reason = lastError?.name === 'AbortError' ? '请求超时' : (lastError?.cause?.message || lastError?.message || '连接失败');
  throw new Error(`${label}失败：${reason}${code ? ` (${code})` : ''}。请检查网络、代理或防火墙是否允许访问 osu.ppy.sh。`);
}
