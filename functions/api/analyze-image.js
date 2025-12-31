// 檔案：functions/api/analyze-image.js

export async function onRequestPost(context) {
  const { env } = context;

  try {
    // ---------------------------------------------------
    // 這是專門用來「簽署同意書」的程式碼
    // ---------------------------------------------------
    const response = await env.AI.run('@cf/meta/llama-3.2-11b-vision-instruct', {
      messages: [
        {
          role: "user",
          content: "agree" // 這就是簽名
        }
      ]
    });

    // 如果成功，回傳結果給你看
    return new Response(JSON.stringify({ 
      status: "同意成功！現在可以把程式碼改回去了。", 
      ai_response: response 
    }), {
      headers: { "Content-Type": "application/json" }
    });

  } catch (err) {
    // 如果失敗，顯示錯誤
    return new Response(JSON.stringify({ error: err.message }), { 
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
}