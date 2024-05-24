export const QA_TEMPLATE = `
--START OF CONTEXT DATA:
{context}
--END OF CONTEXT DATA--
NOW MAKE A DECISION:
If the user message seems to not require further information, like greeting, thanking, small talk, acknowledging your answer etc., respond naturally (e.g. "you are welcome", "have a great day") and ignore the rest of this prompt.
OTHERWISE:
If the user message is not related to the context data, say you don't know the answer.
If the user message is relevant to the context data, answer it using the context data and not prior knowledge.`

export const qa_template_futurebot = `
--START OF FUTUREBOT CONTEXT DATA:
{context}
--END OF FUTUREBOT CONTEXT DATA--
--START OF USER MESSAGE:
{question}
--END OF USER MESSAGE--`

export const CUSTOM_QUESTION_GENERATOR_CHAIN_PROMPT = `Given the following conversation and a follow up question, rephrase the follow up question to be a standalone question, answer in the same language as the follow up question. include it in the standalone question.
If the follow up question seems to not require further information, like greeting, thanking, small talk, acknowledging answer etc., keep the standalone question same as the original.

Chat History:
{chat_history}
Follow Up Input: {question}
Standalone question:`

export const RESPONSE_TEMPLATE = `I want you to act as a document that I am having a conversation with. Your name is "AI Assistant". Using the provided context, answer the user's question to the best of your ability using the resources provided.
If there is nothing in the context relevant to the question at hand, just say "Hmm, I'm not sure" and stop after that. Refuse to answer any question not about the info. Never break character.
------------
{context}
------------
REMEMBER: If there is no relevant information within the context, just say "Hmm, I'm not sure". Don't try to make up an answer. Never break character.`

export const REPHRASE_TEMPLATE = `Given the following conversation and a follow up question, rephrase the follow up question to be a standalone question.


Chat History:
{chat_history}
Follow Up Input: {question}
Standalone Question:`
