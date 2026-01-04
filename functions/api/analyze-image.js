// Cloudflare Pages Function for analyzing bank transaction images
// Using Cloudflare Workers AI (Free, no quota limits)
// File: functions/api/analyze-image.js

export async function onRequest(context) {
    const { request, env } = context;

    const corsHeaders = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') {
        return new Response(null, { headers: corsHeaders });
    }

    if (request.method === 'GET') {
        return new Response(JSON.stringify({
            status: 'ok',
            message: 'Cloudflare Workers AI ready',
            hasAI: !!env.AI
        }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
    }

    if (request.method !== 'POST') {
        return new Response(JSON.stringify({ error: 'Method not allowed' }), {
            status: 405,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
    }

    try {
        // Check if Workers AI is bound
        if (!env.AI) {
            return new Response(JSON.stringify({
                error: 'Workers AI not configured. Please add AI binding in Cloudflare Pages settings.',
                success: false,
                transactions: []
            }), {
                status: 500,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            });
        }

        const { image, prompt, members, currency } = await request.json();

        if (!image) {
            return new Response(JSON.stringify({ error: 'No image provided' }), {
                status: 400,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            });
        }

        // Parse base64 image
        const match = image.match(/^data:(image\/[a-zA-Z]+);base64,(.+)$/);
        let base64Data = image;

        if (match) {
            base64Data = match[2];
        } else if (image.startsWith('data:')) {
            const parts = image.split(',');
            if (parts.length === 2) {
                base64Data = parts[1];
            }
        }

        // Convert base64 to Uint8Array for Workers AI
        const binaryString = atob(base64Data);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i);
        }

        console.log('Calling Cloudflare Workers AI...');
        console.log('User Prompt:', prompt);
        console.log('Members:', members);

        const memberListStr = members && members.length > 0 ? members.join(', ') : 'No specific members provided';
        const currencyStr = currency || 'TWD';

        const systemPrompt = `You are a financial transaction analyzer. Analyze this bank app screenshot or receipt image.

Valid Members for this ledger: [${memberListStr}]
Currency: ${currencyStr}

USER INSTRUCTIONS: 
"${prompt || 'None'}"

Task:
1. Look at the image carefully and extract all visible transactions (date, merchant/description, amount).
2. Apply USER INSTRUCTIONS to determine 'payer', 'involved' members list, or modify 'description' if specified.
3. If no user instructions given, use defaults: payer=first member or "unknown", involved=all members, split=equal.

You MUST return ONLY a valid JSON array with this exact format, no other text:
[{
  "date": "YYYY-MM-DD",
  "description": "Item or Merchant Name", 
  "category": "food/transport/groceries/shopping/entertainment/health/education/accommodation/transfers/other", 
  "amount": 100.00, 
  "type": "expense",
  "payer": "MemberName",
  "involved": ["MemberA", "MemberB"],
  "splitType": "equal"
}]

If you cannot see any transactions in the image, return an empty array: []`;

        // Use Cloudflare Workers AI with LLaVA model (vision-capable)
        const response = await env.AI.run('@cf/llava-hf/llava-1.5-7b-hf', {
            prompt: systemPrompt,
            image: [...bytes]  // Convert Uint8Array to regular array
        });

        console.log('Workers AI Response:', response);

        let transactions = [];

        if (response && response.response) {
            const content = response.response;
            console.log('AI Content:', content);

            try {
                // Try to extract JSON from the response
                let jsonStr = content;

                // Try to find JSON array in the response
                const jsonMatch = content.match(/\[[\s\S]*\]/);
                if (jsonMatch) {
                    jsonStr = jsonMatch[0];
                }

                const parsed = JSON.parse(jsonStr);
                const txArray = Array.isArray(parsed) ? parsed : (parsed.transactions || []);

                transactions = txArray
                    .filter(tx => tx.amount && parseFloat(tx.amount) > 0 && tx.description)
                    .map(tx => ({
                        date: tx.date || new Date().toISOString().split('T')[0],
                        description: tx.description,
                        category: mapCategory(tx.description, tx.category),
                        amount: Math.round(parseFloat(tx.amount) * 100) / 100,
                        txType: tx.type === 'income' ? 'income' : 'expense',
                        payer: tx.payer || (members && members[0]) || '',
                        involved: tx.involved || members || [],
                        splitType: tx.splitType || 'equal'
                    }));

                // Deduplicate
                transactions = transactions.filter((item, index, self) =>
                    index === self.findIndex(t =>
                        t.date === item.date &&
                        t.description === item.description &&
                        Math.abs(t.amount - item.amount) < 0.01
                    )
                );
            } catch (parseError) {
                console.error('Parse error:', parseError, 'Content:', content);
            }
        }

        return new Response(JSON.stringify({
            success: transactions.length > 0,
            transactions: transactions,
            count: transactions.length,
            source: 'cloudflare-workers-ai'
        }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });

    } catch (error) {
        console.error('Error:', error);
        return new Response(JSON.stringify({
            error: error.message,
            success: false,
            transactions: []
        }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
    }
}

function mapCategory(name, originalCat) {
    const lowerName = (name || '').toLowerCase();
    const lowerCat = (originalCat || '').toLowerCase();

    if (lowerName.includes('tangerpay')) return 'laundry';
    if (lowerName.includes('qut') || lowerName.includes('queensland university')) return 'education';
    if (lowerName.includes('iglu')) return 'accommodation';

    if (lowerCat.includes('eating out') || lowerCat.includes('takeaway')) return 'food';
    if (lowerCat.includes('groceries')) return 'groceries';
    if (lowerCat.includes('education')) return 'education';
    if (lowerCat.includes('shopping')) return 'shopping';
    if (lowerCat.includes('transfer') || lowerCat.includes('payment')) return 'transfers';
    if (lowerCat.includes('entertainment')) return 'entertainment';
    if (lowerCat.includes('transport')) return 'vehicle';
    if (lowerCat.includes('health')) return 'health';

    if (lowerName.includes('kfc') || lowerName.includes('mcdonald') || lowerName.includes('cafe')) return 'food';
    if (lowerName.includes('mart') || lowerName.includes('coles') || lowerName.includes('woolworths')) return 'groceries';
    if (lowerName.includes('target')) return 'shopping';

    return 'other';
}
