/**
 * Test script for L2 flow
 * This tests the new official-quote-v2 implementation independently
 * Run with: node official-quote-v2/test-l2-flow.js
 */

const { handleOfficialQuoteV2 } = require('./handler');

// Test configurations
const TEST_SCENARIOS = {
    // Test 1: Purchase with L2 questions forced
    purchaseWithL2: {
        httpMethod: 'POST',
        path: '/official-quote-v2',
        body: JSON.stringify({
            action: 'start',
            PostalCode: '10001',
            SalesContractAmount: 500000,
            NoteAmount: 400000,
            LoanPurposeType: 'Purchase',
            forceL2Questions: true // Force L2 questions even if defaults available
        })
    },
    
    // Test 2: Refinance
    refinance: {
        httpMethod: 'POST',
        path: '/official-quote-v2',
        body: JSON.stringify({
            action: 'start',
            PostalCode: '10001',
            SalesContractAmount: 0,
            NoteAmount: 350000,
            LoanPurposeType: 'Refinance',
            forceL2Questions: false
        })
    },
    
    // Test 3: Cash purchase
    cashPurchase: {
        httpMethod: 'POST',
        path: '/official-quote-v2',
        body: JSON.stringify({
            action: 'start',
            PostalCode: '10001',
            SalesContractAmount: 750000,
            NoteAmount: 0,
            LoanPurposeType: 'Cash Purchase',
            forceL2Questions: false
        })
    }
};

// Mock answers for L2 questions
const MOCK_ANSWERS = {
    'P0_1204': '2', // Not vacant land
    'CT0_1107': '2', // No construction escrow
    'CT0_1108': '2', // No recent improvements
};

/**
 * Test the complete L2 flow
 */
async function testL2Flow() {
    console.log('='.repeat(50));
    console.log('Testing Official Quote V2 with L2 Support');
    console.log('='.repeat(50));
    
    try {
        // Test 1: Start a quote that should return L2 questions
        console.log('\n📝 Test 1: Starting quote with forced L2 questions...');
        const startResponse = await handleOfficialQuoteV2(TEST_SCENARIOS.purchaseWithL2);
        
        console.log('Response Status:', startResponse.statusCode);
        const startBody = JSON.parse(startResponse.body);
        
        if (startBody.error) {
            console.error('❌ Error starting quote:', startBody.error);
            return;
        }
        
        console.log('✅ Session ID:', startBody.sessionId);
        console.log('📋 Status:', startBody.status);
        
        if (startBody.questions) {
            console.log('📝 L2 Questions received:', startBody.questions.length);
            startBody.questions.forEach((q, i) => {
                console.log(`  ${i + 1}. ${q.question}`);
                if (q.options) {
                    q.options.forEach(opt => {
                        console.log(`     - ${opt.label}: ${opt.value}`);
                    });
                }
            });
            
            // Test 2: Submit answers
            console.log('\n📤 Test 2: Submitting answers...');
            const submitEvent = {
                httpMethod: 'POST',
                path: '/official-quote-v2',
                body: JSON.stringify({
                    action: 'submit',
                    sessionId: startBody.sessionId,
                    answers: MOCK_ANSWERS
                })
            };
            
            const submitResponse = await handleOfficialQuoteV2(submitEvent);
            console.log('Response Status:', submitResponse.statusCode);
            
            const submitBody = JSON.parse(submitResponse.body);
            if (submitBody.error) {
                console.error('❌ Error submitting answers:', submitBody.error);
                if (submitBody.validationErrors) {
                    console.error('Validation errors:', submitBody.validationErrors);
                }
            } else {
                console.log('✅ Quote completed successfully!');
                console.log('💰 Total Buyer Fee:', submitBody.totalBuyerFee);
                console.log('💰 Total Seller Fee:', submitBody.totalSellerFee);
                console.log('📄 Number of fees:', submitBody.fees?.length || 0);
            }
            
            // Test 3: Check status
            console.log('\n🔍 Test 3: Checking session status...');
            const statusEvent = {
                httpMethod: 'POST',
                path: '/official-quote-v2',
                body: JSON.stringify({
                    action: 'status',
                    sessionId: startBody.sessionId
                })
            };
            
            const statusResponse = await handleOfficialQuoteV2(statusEvent);
            const statusBody = JSON.parse(statusResponse.body);
            console.log('📊 Session Status:', statusBody.status);
            
        } else if (startBody.hasCalculatedRates) {
            console.log('✅ Rates calculated immediately (no L2 questions needed)');
            console.log('💰 Fees returned:', startBody.fees?.length || 0);
        }
        
    } catch (error) {
        console.error('❌ Test failed:', error);
        console.error('Stack trace:', error.stack);
    }
    
    console.log('\n' + '='.repeat(50));
    console.log('Test Complete');
    console.log('='.repeat(50));
}

/**
 * Test quick quote compatibility (ensure it still works)
 */
async function testQuickQuoteCompatibility() {
    console.log('\n' + '='.repeat(50));
    console.log('Testing Quick Quote Compatibility');
    console.log('='.repeat(50));
    
    try {
        const { handleQuickQuote } = require('../quick-quote/handler');
        
        const quickQuoteEvent = {
            httpMethod: 'POST',
            path: '/',
            body: JSON.stringify({
                PostalCode: '10001',
                SalesContractAmount: 500000,
                NoteAmount: 400000,
                LoanPurposeType: 'Purchase'
            })
        };
        
        console.log('\n🚀 Testing quick quote (should be unaffected)...');
        const response = await handleQuickQuote(quickQuoteEvent);
        
        if (response.statusCode === 200) {
            console.log('✅ Quick quote still works!');
            const body = JSON.parse(response.body);
            console.log('💰 Total Buyer Fee:', body.totalBuyerFee);
        } else {
            console.error('❌ Quick quote failed with status:', response.statusCode);
        }
        
    } catch (error) {
        console.error('❌ Quick quote compatibility test failed:', error.message);
    }
}

/**
 * Run all tests
 */
async function runAllTests() {
    // Set AWS region for DynamoDB
    process.env.AWS_REGION = process.env.AWS_REGION || 'us-east-1';
    
    // Test L2 flow
    await testL2Flow();
    
    // Test quick quote compatibility
    await testQuickQuoteCompatibility();
    
    console.log('\n✅ All tests completed');
}

// Run tests if executed directly
if (require.main === module) {
    runAllTests().catch(error => {
        console.error('Fatal error:', error);
        process.exit(1);
    });
}

module.exports = {
    testL2Flow,
    testQuickQuoteCompatibility
};