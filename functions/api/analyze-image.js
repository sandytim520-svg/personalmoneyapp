// Cloudflare Pages Function for analyzing bank transaction images
// Using Cloudflare Workers AI - UForm Gen2 Qwen
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
            message: 'Cloudflare Workers AI endpoint ready',
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
        if (!env.AI) {
            return new Response(JSON.stringify({ 
                error: 'Workers AI not configured',
                success: false,
                transactions: []
            }), {
                status: 500,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            });
        }

        const { image } = await request.json();
        
        if (!image) {
            return new Response(JSON.stringify({ error: 'No image provided' }), {
                status: 400,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            });
        }

        let base64Data = '';
        if (image.startsWith('data:')) {
            const commaIndex = image.indexOf(',');
            if (commaIndex !== -1) {
                base64Data = image.substring(commaIndex + 1);
            }
        } else {
            base64Data = image;
        }

        if (!base64Data) {
            return new Response(JSON.stringify({ error: 'No base64 data found' }), {
                status: 400,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            });
        }

        const binaryString = atob(base64Data);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i);
        }

        console.log('Calling UForm Gen2 Qwen model...');

        // Call UForm Gen2 Qwen model
        const aiResponse = await env.AI.run('@cf/unum/uform-gen2-qwen-500m', {
            image: Array.from(bytes),
            prompt: `Read this bank screenshot. List each transaction as JSON.

Format: [{"date":"2025-11-02","name":"Store Name","amt":24.35,"exp":true}]

date: YYYY-MM-DD format
name: merchant name
amt: dollar amount as number
exp: true if expense, false if income

Extract all visible transactions:`
        });

        console.log('AI Response:', JSON.stringify(aiResponse));

        let transactions = [];
        
        try {
            const responseText = aiResponse.response || aiResponse.description || JSON.stringify(aiResponse);
            console.log('Response text:', responseText);
            
            const jsonMatch = responseText.match(/\[[\s\S]*?\]/);
            if (jsonMatch) {
                const parsed = JSON.parse(jsonMatch[0]);
                
                transactions = parsed
                    .filter(tx => tx.amt && parseFloat(tx.amt) > 0 && tx.name)
                    .map(tx => ({
                        date: tx.date || new Date().toISOString().split('T')[0],
                        description: tx.name || 'Unknown',
                        category: mapCategory(tx.name, tx.cat || ''),
                        amount: Math.round(parseFloat(tx.amt) * 100) / 100,
                        txType: tx.exp === false ? 'income' : 'expense'
                    }));
                
                transactions = transactions.filter((item, index, self) =>
                    index === self.findIndex(t => 
                        t.date === item.date && 
                        t.description === item.description && 
                        Math.abs(t.amount - item.amount) < 0.01
                    )
                );
            }
        } catch (parseError) {
            console.error('Parse error:', parseError);
        }

        return new Response(JSON.stringify({ 
            success: transactions.length > 0, 
            transactions: transactions,
            count: transactions.length,
            source: 'cloudflare-uform-gen2-qwen'
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
    
    if (lowerCat.includes('eating out') || lowerCat.includes('takeaway') || lowerCat.includes('food')) return 'food';
    if (lowerCat.includes('groceries') || lowerCat.includes('grocery')) return 'groceries';
    if (lowerCat.includes('education')) return 'education';
    if (lowerCat.includes('shopping')) return 'shopping';
    if (lowerCat.includes('transfer') || lowerCat.includes('payment')) return 'transfers';
    
    if (lowerName.includes('kfc') || lowerName.includes('mcdonald') || lowerName.includes('cafe')) return 'food';
    if (lowerName.includes('mart') || lowerName.includes('coles') || lowerName.includes('woolworths')) return 'groceries';
    
    return 'other';
}
