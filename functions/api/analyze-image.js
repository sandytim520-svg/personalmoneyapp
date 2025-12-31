// Cloudflare Pages Function for analyzing bank transaction images
// Using Cloudflare Workers AI - Llama 3.2 Vision (FREE)
// File: functions/api/analyze-image.js

export async function onRequest(context) {
    const { request, env } = context;
    
    const corsHeaders = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
    };

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
        return new Response(null, { headers: corsHeaders });
    }

    // Handle GET (for testing)
    if (request.method === 'GET') {
        return new Response(JSON.stringify({ 
            status: 'ok', 
            message: 'Cloudflare Workers AI endpoint ready',
            hasAI: !!env.AI
        }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
    }

    // Handle POST
    if (request.method !== 'POST') {
        return new Response(JSON.stringify({ error: 'Method not allowed' }), {
            status: 405,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
    }

    try {
        // Check AI binding
        if (!env.AI) {
            console.error('Workers AI not bound');
            return new Response(JSON.stringify({ 
                error: 'Workers AI not configured. Please add AI binding in Cloudflare settings.',
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

        // Extract base64 data
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

        // Convert base64 to Uint8Array for Workers AI
        const binaryString = atob(base64Data);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i);
        }

        console.log('Calling Cloudflare Workers AI...');

        // Call Llama 3.2 Vision model
        const aiResponse = await env.AI.run('@cf/meta/llama-3.2-11b-vision-instruct', {
            image: Array.from(bytes),
            prompt: `Look at this bank app screenshot. List each transaction you can see.

For each transaction, tell me:
1. DATE: Convert "Sun 02 Nov 2025" to "2025-11-02"
2. NAME: The merchant name like "KFC (Sebastopol)"
3. CATEGORY: Text below the name like "Groceries"
4. AMOUNT: The number like 24.35 from "-$24.35"
5. TYPE: "expense" if has minus sign, "income" if no minus

IMPORTANT:
- Skip any transaction where the amount is hidden by a button
- Only list transactions you can clearly see
- Keep exact decimal amounts

Return ONLY a JSON array like this:
[{"date":"2025-11-02","name":"KFC","cat":"Food","amt":24.35,"exp":true}]

List all visible transactions now:`
        });

        console.log('AI Response:', JSON.stringify(aiResponse));

        let transactions = [];
        
        try {
            const responseText = aiResponse.response || aiResponse.description || JSON.stringify(aiResponse);
            console.log('Response text:', responseText);
            
            // Try to find JSON array in response
            const jsonMatch = responseText.match(/\[[\s\S]*?\]/);
            if (jsonMatch) {
                const parsed = JSON.parse(jsonMatch[0]);
                
                transactions = parsed
                    .filter(tx => tx.amt && parseFloat(tx.amt) > 0 && tx.name)
                    .map(tx => ({
                        date: tx.date || new Date().toISOString().split('T')[0],
                        description: tx.name || 'Unknown',
                        category: mapCategory(tx.name, tx.cat),
                        amount: Math.round(parseFloat(tx.amt) * 100) / 100,
                        txType: tx.exp === false ? 'income' : 'expense'
                    }));
                
                // Remove duplicates
                transactions = transactions.filter((item, index, self) =>
                    index === self.findIndex(t => 
                        t.date === item.date && 
                        t.description === item.description && 
                        Math.abs(t.amount - item.amount) < 0.01
                    )
                );
                
                console.log('Parsed transactions:', transactions.length);
            }
        } catch (parseError) {
            console.error('Parse error:', parseError);
        }

        return new Response(JSON.stringify({ 
            success: transactions.length > 0, 
            transactions: transactions,
            count: transactions.length,
            source: 'cloudflare-llama-3.2-vision'
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

// Custom category mapping
function mapCategory(name, originalCat) {
    const lowerName = (name || '').toLowerCase();
    const lowerCat = (originalCat || '').toLowerCase();
    
    // Custom merchant rules
    if (lowerName.includes('tangerpay')) return 'laundry';
    if (lowerName.includes('qut') || lowerName.includes('queensland university')) return 'education';
    if (lowerName.includes('iglu')) return 'accommodation';
    
    // Map by category text
    if (lowerCat.includes('eating out') || lowerCat.includes('takeaway') || lowerCat.includes('food')) return 'food';
    if (lowerCat.includes('groceries') || lowerCat.includes('grocery')) return 'groceries';
    if (lowerCat.includes('education')) return 'education';
    if (lowerCat.includes('shopping')) return 'shopping';
    if (lowerCat.includes('transfer') || lowerCat.includes('payment')) return 'transfers';
    if (lowerCat.includes('entertainment')) return 'entertainment';
    if (lowerCat.includes('transport')) return 'vehicle';
    if (lowerCat.includes('health')) return 'health';
    
    // Fallback by merchant name
    if (lowerName.includes('kfc') || lowerName.includes('mcdonald') || lowerName.includes('cafe')) return 'food';
    if (lowerName.includes('mart') || lowerName.includes('coles') || lowerName.includes('woolworths')) return 'groceries';
    if (lowerName.includes('target')) return 'shopping';
    
    return 'other';
}
