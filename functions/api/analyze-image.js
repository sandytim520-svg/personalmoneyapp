export async function onRequestPost(context) {
  const { env } = context;

  try {
    // 我們只發送 "agree" 這個字給模型，這就是簽署條款的動作
    const response = await env.AI.run('@cf/meta/llama-3.2-11b-vision-instruct', {
      messages: [
        {
          role: "user",
          content: "agree" // 關鍵在這裡
        }
      ]
    });

    return new Response(JSON.stringify(response), {
      headers: { "Content-Type": "application/json" }
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { 
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
}
