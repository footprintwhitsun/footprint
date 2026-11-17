const axios = require('axios');
const { randomUUID: uuidv4 } = require('crypto');
require('dotenv').config();

const SUBSCRIPTION_KEY = process.env.MTN_MOMO_SUBSCRIPTION_KEY;
const BASE_URL = 'https://sandbox.momodeveloper.mtn.com';

if (!SUBSCRIPTION_KEY) {
    console.error('Error: MTN_MOMO_SUBSCRIPTION_KEY is missing in .env file');
    process.exit(1);
}

const runSetup = async () => {
    try {
        console.log('1. Creating Sandbox API User...');
        const userUuid = uuidv4();
        
        await axios.post(`${BASE_URL}/v1_0/apiuser`, 
            { providerCallbackHost: 'https://webhook.site/b39606f6-188c-4165-9931-2321' }, // Dummy callback for sandbox
            {
                headers: {
                    'X-Reference-Id': userUuid,
                    'Ocp-Apim-Subscription-Key': SUBSCRIPTION_KEY,
                    'Content-Type': 'application/json'
                }
            }
        );
        console.log('   User Created:', userUuid);

        console.log('2. Generating API Key...');
        const apiKeyRes = await axios.post(`${BASE_URL}/v1_0/apiuser/${userUuid}/apikey`, {}, {
            headers: {
                'Ocp-Apim-Subscription-Key': SUBSCRIPTION_KEY
            }
        });
        
        const apiKey = apiKeyRes.data.apiKey;
        console.log('   API Key Generated!');

        console.log('\nSUCCESS! Please add these lines to your .env file:\n');
        console.log(`MTN_MOMO_USER_ID=${userUuid}`);
        console.log(`MTN_MOMO_API_KEY=${apiKey}`);
        console.log(`MTN_MOMO_ENV=sandbox`);

    } catch (error) {
        if (error.response) {
            console.error('API Error:', error.response.status, error.response.data);
        } else {
            console.error('Error:', error.message);
        }
        console.log('\nMake sure your Subscription Key in .env is correct and valid for the "Collections" product (not Collection Widget).');
    }
};

runSetup();