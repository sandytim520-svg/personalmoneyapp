// 檔案：functions/api/analyze-image.js

export async function onRequestPost(context) {
  const { env } = context;

  try {
    // ---------------------------------------------------
    // 修正版：使用陣列格式發送 "agree"
    // ---------------------------------------------------
    const response = await env.AI.run('@cf/meta/llama-3.2-11b-vision-instruct', {
      messages: [
        {
          role: "user",
          content: [
            // 這裡改成陣列物件格式，確保模型能讀懂
            { type: "text", text: "agree" } 
          ]
        }
      ]
    });

    return new Response(JSON.stringify({ 
      status: "同意成功！現在可以把程式碼改回去了。", 
      ai_response: response 
    }), {
      headers: { "Content-Type": "application/json" }
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { 
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
}