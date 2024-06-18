import { Request } from 'express'
import { IFileUpload, convertSpeechToText, ICommonObject, addSingleFileToStorage, addArrayFilesToStorage } from 'flowise-components'
import { StatusCodes } from 'http-status-codes'
import {
    IncomingInput,
    IMessage,
    INodeData,
    IReactFlowObject,
    IReactFlowNode,
    IDepthQueue,
    chatType,
    IChatMessage,
    IChatFlow,
    IReactFlowEdge
} from '../Interface'
import { InternalFlowiseError } from '../errors/internalFlowiseError'
import { ChatFlow } from '../database/entities/ChatFlow'
import { Server } from 'socket.io'
import { getRunningExpressApp } from '../utils/getRunningExpressApp'
import {
    mapMimeTypeToInputField,
    isFlowValidForStream,
    buildFlow,
    getTelemetryFlowObj,
    getAppVersion,
    resolveVariables,
    getSessionChatHistory,
    findMemoryNode,
    replaceInputsWithConfig,
    getStartingNodes,
    isStartNodeDependOnInput,
    getMemorySessionId,
    isSameOverrideConfig,
    getEndingNodes,
    constructGraphs
} from '../utils'
import { utilValidateKey } from './validateKey'
import { databaseEntities } from '.'
import { v4 as uuidv4 } from 'uuid'
import { omit } from 'lodash'
import * as fs from 'fs'
import logger from './logger'
import { utilAddChatMessage } from './addChatMesage'
import { buildAgentGraph } from './buildAgentGraph'
import { getErrorMessage } from '../errors/utils'

import axios, { AxiosRequestConfig } from 'axios'

interface Message {
    message: string
    type?: string
}

interface OpenAIMessage {
    role: string
    content: string
}

async function shouldQueryPinecone(
    messageHistory: Message[],
    message: string,
    vectorDbDescription: string,
    openAIApiKey: string
): Promise<boolean> {
    let convertedHistory: OpenAIMessage[]

    if (!messageHistory) convertedHistory = []
    else
        convertedHistory = messageHistory.map((m: Message): OpenAIMessage => {
            return { role: m.type === 'apiMessage' ? 'assistant' : 'user', content: m.message }
        })

    let prompt =
        "Always answer only a single word: YES or NO. I want you to decide, if the last message is only conversational (NO) or if it's something, that might be" +
        'relevant to the vector database content (YES). The vector database can contain know-how and knowledge of various topics. I am talking to you as if you are the creator of the knowledge.' +
        "If the question is asking info about you, say YES. If it's small talk, greeting or thanking, say NO." +
        "If the message wants to explain something, say YES. If it's a specific question, say YES."

    if (vectorDbDescription && vectorDbDescription.length > 0) {
        prompt +=
            '\n' +
            'The vector database content description:' +
            '\n' +
            vectorDbDescription +
            '\n' +
            'End of database content description. Would you recommend to query the vector database for possible relevant content?'
    }

    let messages: OpenAIMessage[] = [
        {
            role: 'system',
            content: prompt
        }
    ]

    let response = await chatCompletion(
        messages.concat(convertedHistory.slice(-3)).concat([{ role: 'user', content: message }]),
        0,
        openAIApiKey
    )
    return response.data.choices[0].message.content.toLowerCase() === 'yes'
}

async function chatCompletion(messages: OpenAIMessage[], temperature: number, openAIApiKey: string): Promise<any> {
    const config: AxiosRequestConfig = {}
    config.headers = {
        Authorization: `Bearer ${(openAIApiKey ? openAIApiKey : (process.env.OPENAI_API_KEY as string)).trim()}`
    }
    return await axios.post(
        'https://api.openai.com/v1/chat/completions',
        {
            model: 'gpt-4-turbo',
            messages: messages,
            temperature: temperature
        },
        config
    )
}

/**
 * Build Chatflow
 * @param {Request} req
 * @param {Server} socketIO
 * @param {boolean} isInternal
 */
export const utilBuildChatflow = async (req: Request, socketIO?: Server, isInternal: boolean = false): Promise<any> => {
    try {
        logger.info('utilBuildChatflow')

        const appServer = getRunningExpressApp()
        const chatflowid = req.params.id
        const baseURL = `${req.protocol}://${req.get('host')}`

        let incomingInput: IncomingInput = req.body
        let nodeToExecuteData: INodeData

        const isMyCloneGPT = chatflowid === 'e2447fff-842f-4584-8eea-e983d5d9e663'
        const isInternalFuturebotChat = chatflowid === process.env.INTERNAL_CHATFLOW_ID

        /*if (isMyCloneGPT && incomingInput.overrideConfig) {
                let shouldQueryP
                try {
                    shouldQueryP = await this.shouldQueryPinecone(
                        incomingInput.history,
                        incomingInput.question,
                        incomingInput.overrideConfig.databaseDescription,
                        incomingInput.overrideConfig.openAIApiKey
                    )
                } catch (error: any) {
                    if (error.response?.status === 401) throw new Error('Chyba. Chatbot má pravděpodobně neplatný OpenAI API klíč.')
                }
                if (!shouldQueryP) {
                    chatflowid = (process.env.BASIC_CHAT_GPT as string).trim() //switch to conversation without vector database data
                    if (incomingInput.overrideConfig.databaseDescription)
                        incomingInput.overrideConfig.systemMessagePrompt +=
                            "\nThe following is a description of your context data - we are not using context data for this reply, but if needed, use the description to explain what's your knowledge:\n" +
                            incomingInput.overrideConfig.databaseDescription
                }
            }*/

        const chatflow = await appServer.AppDataSource.getRepository(ChatFlow).findOneBy({
            id: chatflowid
        })
        if (!chatflow) {
            throw new InternalFlowiseError(StatusCodes.NOT_FOUND, `Chatflow ${chatflowid} not found`)
        }

        const chatId = incomingInput.chatId ?? incomingInput.overrideConfig?.sessionId ?? incomingInput.socketIOClientId ?? uuidv4()
        const userMessageDateTime = new Date()

        if (!isInternal) {
            const isKeyValidated = await utilValidateKey(req, chatflow)
            if (!isKeyValidated) {
                throw new InternalFlowiseError(StatusCodes.UNAUTHORIZED, `Unauthorized`)
            }
        }

        let fileUploads: IFileUpload[] = []
        if (incomingInput.uploads) {
            fileUploads = incomingInput.uploads
            for (let i = 0; i < fileUploads.length; i += 1) {
                const upload = fileUploads[i]

                if ((upload.type === 'file' || upload.type === 'audio') && upload.data) {
                    const filename = upload.name
                    const splitDataURI = upload.data.split(',')
                    const bf = Buffer.from(splitDataURI.pop() || '', 'base64')
                    const mime = splitDataURI[0].split(':')[1].split(';')[0]
                    await addSingleFileToStorage(mime, bf, filename, chatflowid, chatId)
                    upload.type = 'stored-file'
                    // Omit upload.data since we don't store the content in database
                    fileUploads[i] = omit(upload, ['data'])
                }

                // Run Speech to Text conversion
                if (upload.mime === 'audio/webm' || upload.mime === 'audio/mp4' || upload.mime === 'audio/ogg') {
                    logger.debug(`Attempting a speech to text conversion...`)
                    let speechToTextConfig: ICommonObject = {}
                    if (chatflow.speechToText) {
                        const speechToTextProviders = JSON.parse(chatflow.speechToText)
                        for (const provider in speechToTextProviders) {
                            const providerObj = speechToTextProviders[provider]
                            if (providerObj.status) {
                                speechToTextConfig = providerObj
                                speechToTextConfig['name'] = provider
                                break
                            }
                        }
                    }
                    if (speechToTextConfig) {
                        const options: ICommonObject = {
                            chatId,
                            chatflowid,
                            appDataSource: appServer.AppDataSource,
                            databaseEntities: databaseEntities
                        }
                        const speechToTextResult = await convertSpeechToText(upload, speechToTextConfig, options)
                        logger.debug(`Speech to text result: ${speechToTextResult}`)
                        if (speechToTextResult) {
                            incomingInput.question = speechToTextResult
                        }
                    }
                }
            }
        }

        let isStreamValid = false

        const files = (req.files as Express.Multer.File[]) || []

        if (files.length) {
            const overrideConfig: ICommonObject = { ...req.body }
            const fileNames: string[] = []
            for (const file of files) {
                const fileBuffer = fs.readFileSync(file.path)

                const storagePath = await addArrayFilesToStorage(file.mimetype, fileBuffer, file.originalname, fileNames, chatflowid)

                const fileInputField = mapMimeTypeToInputField(file.mimetype)

                overrideConfig[fileInputField] = storagePath

                fs.unlinkSync(file.path)
            }
            incomingInput = {
                question: req.body.question ?? 'hello',
                overrideConfig,
                socketIOClientId: req.body.socketIOClientId
            }
        }

        /*** Get chatflows and prepare data  ***/
        const flowData = chatflow.flowData
        const parsedFlowData: IReactFlowObject = JSON.parse(flowData)
        const nodes = parsedFlowData.nodes
        const edges = parsedFlowData.edges

        /*      incomingInput.overrideConfig &&
                    incomingInput.overrideConfig.openAIApiKey &&
                    incomingInput.overrideConfig.openAIApiKey.length > 1*/

        let mycloneWhitelist = ['pavel-smbc', 'smc-podpora', 'testdata']

        let futurebotPineconePromise
        let acSummaryPromise

        if (incomingInput.overrideConfig && incomingInput.overrideConfig.pineconeNamespace === process.env.FUTUREBOT_ID) {
            if (!incomingInput.overrideConfig.expertProfileUid)
                throw new InternalFlowiseError(403, `Nepodařilo se identifikovat uživatele, ujistěte se, že jste přihlášeni.`)

            futurebotPineconePromise = axios.post('https://' + process.env.LAMBDA_URL + '.lambda-url.eu-central-1.on.aws/', {
                method: 'search',
                value: req.body.question,
                userId: incomingInput.overrideConfig.expertProfileUid
            })

            //logger.info('fetched data for profile ' + incomingInput.overrideConfig.expertProfileUid + ', data:\n' + JSON.stringify(related.texts));

            acSummaryPromise = axios.post('https://futurebot.ai/api/flowise/v1/ac_summary/', {
                userId: incomingInput.overrideConfig.expertProfileUid,
                secret: process.env.FUTUREBOT_API_SECRET
            })
        }

        if (
            !process.env.ISLOCAL &&
            isMyCloneGPT &&
            !(
                incomingInput.overrideConfig &&
                mycloneWhitelist.includes(incomingInput.overrideConfig.pineconeNamespace) &&
                incomingInput.overrideConfig.systemMessagePrompt
            )
        ) {
            logger.info('Calling check_flowise_permissions')

            if (!incomingInput.overrideConfig) throw new InternalFlowiseError(403, `Chatbot nemá nastavenou konfiguraci.`)

            let permissionsResult = (
                await axios.post('https://futurebot.ai/api/flowise/v1/check_flowise_permissions/', {
                    userId: incomingInput.overrideConfig.pineconeNamespace,
                    sessionId: !incomingInput.chatId ? incomingInput.socketIOClientId : incomingInput.chatId,
                    limitId: incomingInput.limitId,
                    secret: process.env.FUTUREBOT_API_SECRET
                })
            ).data

            if (!permissionsResult || !permissionsResult.status)
                throw new InternalFlowiseError(
                    403,
                    permissionsResult.reason ??
                        `Byl dosažen limit požadavků, je vyžadován vlastní chatGPT API klíč. Upozorněte provozovatele této stránky.`
                )

            if (permissionsResult.customApiKey && permissionsResult.customApiKey.length > 1)
                incomingInput.overrideConfig.openAIApiKey = permissionsResult.customApiKey

            incomingInput.overrideConfig.systemMessagePrompt = permissionsResult.systemMessagePrompt
            incomingInput.overrideConfig.topK = permissionsResult.topK
            incomingInput.overrideConfig.returnSourceDocuments = permissionsResult.returnSourceDocuments

            if (!incomingInput.overrideConfig.systemMessagePrompt) throw new InternalFlowiseError(403, `Chatbot nemá nastavený prompt.`)
        }

        if (incomingInput.overrideConfig && incomingInput.overrideConfig.pineconeNamespace === process.env.API_TEST_ID) {
            return { statusCode: 200, message: 'OK' }
        }

        if (incomingInput.overrideConfig && incomingInput.overrideConfig.pineconeNamespace === process.env.FUTUREBOT_ID) {
            // @ts-ignore
            let related
            try {
                if (futurebotPineconePromise) related = (await futurebotPineconePromise).data
            } catch (e) {
                logger.info('No context data found for profile ' + incomingInput.overrideConfig.expertProfileUid)
            }
            //logger.info('fetched data for profile ' + incomingInput.overrideConfig.expertProfileUid + ', data:\n' + JSON.stringify(related.texts));

            // @ts-ignore
            let acSummary = (await acSummaryPromise).data

            if (acSummary && acSummary.error) throw new InternalFlowiseError(403, acSummary.reason)

            let summaryString = JSON.stringify(acSummary)

            //logger.info('fetched ac summary: ' + summaryString);

            const language = acSummary.language

            //logger.info('language: ' + language);

            let futureBotPrompt =
                'Odpovědi piš výhradně v jazyce ' +
                language +
                ' bez ohledu na text uživatele.\n' +
                incomingInput.overrideConfig.systemMessagePrompt +
                '\n--USER PROFILE INFO:\n' +
                summaryString +
                '\n--END OF USER PROFILE INFO--\n--START OF USER CONTEXT DATA:\n' +
                (related ? JSON.stringify(related.texts) : 'empty') +
                '\n--END OF USER CONTEXT DATA--'

            incomingInput.overrideConfig.systemMessagePrompt = futureBotPrompt.replace(/{/g, '{{').replace(/}/g, '}}') //needed to ensure the template replacing {terms} works
            incomingInput.overrideConfig.isFuturebot = true
        }

        /*** Get session ID ***/
        const memoryNode = findMemoryNode(nodes, edges)
        const memoryType = memoryNode?.data.label
        let sessionId = getMemorySessionId(memoryNode, incomingInput, chatId, isInternal)

        /*** Get Ending Node with Directed Graph  ***/
        const { graph, nodeDependencies } = constructGraphs(nodes, edges)
        const directedGraph = graph
        const endingNodes = getEndingNodes(nodeDependencies, directedGraph, nodes)

        /*** If the graph is an agent graph, build the agent response ***/
        if (endingNodes.filter((node) => node.data.category === 'Multi Agents').length) {
            return await utilBuildAgentResponse(
                chatflow,
                isInternal,
                chatId,
                memoryType ?? '',
                sessionId,
                userMessageDateTime,
                fileUploads,
                incomingInput,
                nodes,
                edges,
                socketIO,
                baseURL
            )
        }

        // Get prepend messages
        const prependMessages = incomingInput.history

        /*   Reuse the flow without having to rebuild (to avoid duplicated upsert, recomputation, reinitialization of memory) when all these conditions met:
         * - Node Data already exists in pool
         * - Still in sync (i.e the flow has not been modified since)
         * - Existing overrideConfig and new overrideConfig are the same
         * - Flow doesn't start with/contain nodes that depend on incomingInput.question
         ***/
        const isFlowReusable = () => {
            return (
                Object.prototype.hasOwnProperty.call(appServer.chatflowPool.activeChatflows, chatflowid) &&
                appServer.chatflowPool.activeChatflows[chatflowid].inSync &&
                appServer.chatflowPool.activeChatflows[chatflowid].endingNodeData &&
                isSameOverrideConfig(
                    isInternal,
                    appServer.chatflowPool.activeChatflows[chatflowid].overrideConfig,
                    incomingInput.overrideConfig
                ) &&
                !isStartNodeDependOnInput(appServer.chatflowPool.activeChatflows[chatflowid].startingNodes, nodes)
            )
        }

        if (isFlowReusable()) {
            nodeToExecuteData = appServer.chatflowPool.activeChatflows[chatflowid].endingNodeData as INodeData
            isStreamValid = isFlowValidForStream(nodes, nodeToExecuteData)
            logger.debug(
                `[server]: Reuse existing chatflow ${chatflowid} with ending node ${nodeToExecuteData.label} (${nodeToExecuteData.id})`
            )
        } else {
            const isCustomFunctionEndingNode = endingNodes.some((node) => node.data?.outputs?.output === 'EndingNode')

            for (const endingNode of endingNodes) {
                const endingNodeData = endingNode.data

                const isEndingNode = endingNodeData?.outputs?.output === 'EndingNode'

                // Once custom function ending node exists, no need to do follow-up checks.
                if (isEndingNode) continue

                if (
                    endingNodeData.outputs &&
                    Object.keys(endingNodeData.outputs).length &&
                    !Object.values(endingNodeData.outputs ?? {}).includes(endingNodeData.name)
                ) {
                    throw new InternalFlowiseError(
                        StatusCodes.INTERNAL_SERVER_ERROR,
                        `Output of ${endingNodeData.label} (${endingNodeData.id}) must be ${endingNodeData.label}, can't be an Output Prediction`
                    )
                }

                isStreamValid = isFlowValidForStream(nodes, endingNodeData)
            }

            // Once custom function ending node exists, flow is always unavailable to stream
            isStreamValid = isCustomFunctionEndingNode ? false : isStreamValid

            let chatHistory: IMessage[] = []

            // When {{chat_history}} is used in Format Prompt Value, fetch the chat conversations from memory node
            for (const endingNode of endingNodes) {
                const endingNodeData = endingNode.data

                if (!endingNodeData.inputs?.memory) continue

                const memoryNodeId = endingNodeData.inputs?.memory.split('.')[0].replace('{{', '')
                const memoryNode = nodes.find((node) => node.data.id === memoryNodeId)

                if (!memoryNode) continue

                chatHistory = await getSessionChatHistory(
                    chatflowid,
                    getMemorySessionId(memoryNode, incomingInput, chatId, isInternal),
                    memoryNode,
                    appServer.nodesPool.componentNodes,
                    appServer.AppDataSource,
                    databaseEntities,
                    logger,
                    prependMessages
                )
            }

            /*** Get Starting Nodes with Reversed Graph ***/
            const constructedObj = constructGraphs(nodes, edges, { isReversed: true })
            const nonDirectedGraph = constructedObj.graph
            let startingNodeIds: string[] = []
            let depthQueue: IDepthQueue = {}
            const endingNodeIds = endingNodes.map((n) => n.id)
            for (const endingNodeId of endingNodeIds) {
                const resx = getStartingNodes(nonDirectedGraph, endingNodeId)
                startingNodeIds.push(...resx.startingNodeIds)
                depthQueue = Object.assign(depthQueue, resx.depthQueue)
            }
            startingNodeIds = [...new Set(startingNodeIds)]

            const startingNodes = nodes.filter((nd) => startingNodeIds.includes(nd.id))

            logger.debug(`[server]: Start building chatflow ${chatflowid}`)
            /*** BFS to traverse from Starting Nodes to Ending Node ***/
            const reactFlowNodes = await buildFlow(
                startingNodeIds,
                nodes,
                edges,
                graph,
                depthQueue,
                appServer.nodesPool.componentNodes,
                incomingInput.question,
                chatHistory,
                chatId,
                sessionId ?? '',
                chatflowid,
                appServer.AppDataSource,
                incomingInput?.overrideConfig,
                appServer.cachePool,
                false,
                undefined,
                incomingInput.uploads,
                baseURL,
                socketIO,
                incomingInput.socketIOClientId
            )

            const nodeToExecute =
                endingNodeIds.length === 1
                    ? reactFlowNodes.find((node: IReactFlowNode) => endingNodeIds[0] === node.id)
                    : reactFlowNodes[reactFlowNodes.length - 1]
            if (!nodeToExecute) {
                throw new InternalFlowiseError(StatusCodes.NOT_FOUND, `Node not found`)
            }

            if (incomingInput.overrideConfig) {
                nodeToExecute.data = replaceInputsWithConfig(nodeToExecute.data, incomingInput.overrideConfig)
            }

            const reactFlowNodeData: INodeData = resolveVariables(nodeToExecute.data, reactFlowNodes, incomingInput.question, chatHistory)
            nodeToExecuteData = reactFlowNodeData

            appServer.chatflowPool.add(chatflowid, nodeToExecuteData, startingNodes, incomingInput?.overrideConfig)
        }

        logger.debug(`[server]: Running ${nodeToExecuteData.label} (${nodeToExecuteData.id})`)

        const nodeInstanceFilePath = appServer.nodesPool.componentNodes[nodeToExecuteData.name].filePath as string
        const nodeModule = await import(nodeInstanceFilePath)
        const nodeInstance = new nodeModule.nodeClass({ sessionId })

        let saveMessagePromise
        if (!process.env.ISLOCAL && (isMyCloneGPT || isInternalFuturebotChat) && incomingInput.overrideConfig) {
            try {
                saveMessagePromise = axios.post('https://futurebot.ai/api/flowise/v1/save_flowise_message/', {
                    userId: isInternalFuturebotChat ? 'internal' : incomingInput.overrideConfig.pineconeNamespace,
                    sessionId: isInternalFuturebotChat
                        ? incomingInput.overrideConfig.instanceId
                        : !incomingInput.chatId
                        ? incomingInput.socketIOClientId
                        : incomingInput.chatId,
                    limitId: incomingInput.limitId,
                    message: incomingInput.question,
                    isBot: false
                })
            } catch (e) {
                console.error(e)
            }
        }

        let result = isStreamValid
            ? await nodeInstance.run(nodeToExecuteData, incomingInput.question, {
                  chatId,
                  chatflowid,
                  logger,
                  appDataSource: appServer.AppDataSource,
                  databaseEntities,
                  analytic: chatflow.analytic,
                  uploads: incomingInput.uploads,
                  socketIO,
                  socketIOClientId: incomingInput.socketIOClientId,
                  prependMessages
              })
            : await nodeInstance.run(nodeToExecuteData, incomingInput.question, {
                  chatId,
                  chatflowid,
                  logger,
                  appDataSource: appServer.AppDataSource,
                  databaseEntities,
                  analytic: chatflow.analytic,
                  uploads: incomingInput.uploads,
                  prependMessages
              })
        result = typeof result === 'string' ? { text: result } : result

        // Retrieve threadId from assistant if exists
        if (typeof result === 'object' && result.assistant) {
            sessionId = result.assistant.threadId
        }

        const userMessage: Omit<IChatMessage, 'id'> = {
            role: 'userMessage',
            content: incomingInput.question,
            chatflowid,
            chatType: isInternal ? chatType.INTERNAL : chatType.EXTERNAL,
            chatId,
            memoryType,
            sessionId,
            createdDate: userMessageDateTime,
            fileUploads: incomingInput.uploads ? JSON.stringify(fileUploads) : undefined,
            leadEmail: incomingInput.leadEmail
        }
        await utilAddChatMessage(userMessage)

        let resultText = ''
        if (result.text) resultText = result.text
        else if (result.json) resultText = '```json\n' + JSON.stringify(result.json, null, 2)
        else resultText = JSON.stringify(result, null, 2)

        const apiMessage: Omit<IChatMessage, 'id' | 'createdDate'> = {
            role: 'apiMessage',
            content: resultText,
            chatflowid,
            chatType: isInternal ? chatType.INTERNAL : chatType.EXTERNAL,
            chatId,
            memoryType,
            sessionId
        }
        if (result?.sourceDocuments) apiMessage.sourceDocuments = JSON.stringify(result.sourceDocuments)
        if (result?.usedTools) apiMessage.usedTools = JSON.stringify(result.usedTools)
        if (result?.fileAnnotations) apiMessage.fileAnnotations = JSON.stringify(result.fileAnnotations)
        const chatMessage = await utilAddChatMessage(apiMessage)

        logger.debug(`[server]: Finished running ${nodeToExecuteData.label} (${nodeToExecuteData.id})`)
        await appServer.telemetry.sendTelemetry('prediction_sent', {
            version: await getAppVersion(),
            chatflowId: chatflowid,
            chatId,
            type: isInternal ? chatType.INTERNAL : chatType.EXTERNAL,
            flowGraph: getTelemetryFlowObj(nodes, edges)
        })

        // Prepare response
        // return the question in the response
        // this is used when input text is empty but question is in audio format
        result.question = incomingInput.question
        result.chatId = chatId
        result.chatMessageId = chatMessage?.id
        if (sessionId) result.sessionId = sessionId
        if (memoryType) result.memoryType = memoryType

        if (!process.env.ISLOCAL && (isMyCloneGPT || isInternalFuturebotChat) && incomingInput.overrideConfig) {
            try {
                await axios.post('https://futurebot.ai/api/flowise/v1/save_flowise_message/', {
                    userId: isInternalFuturebotChat ? 'internal' : incomingInput.overrideConfig.pineconeNamespace,
                    sessionId: isInternalFuturebotChat
                        ? incomingInput.overrideConfig.instanceId
                        : !incomingInput.chatId
                        ? incomingInput.socketIOClientId
                        : incomingInput.chatId,
                    limitId: incomingInput.limitId,
                    message: result.text ? result.text : result,
                    isBot: true
                })
            } catch (e) {
                console.error(e)
            }

            try {
                await saveMessagePromise
            } catch (e) {
                console.error(e)
            }
        }

        return result
    } catch (e) {
        logger.error('[server]: Error:', e)
        throw new InternalFlowiseError(StatusCodes.INTERNAL_SERVER_ERROR, getErrorMessage(e))
    }
}

const utilBuildAgentResponse = async (
    chatflow: IChatFlow,
    isInternal: boolean,
    chatId: string,
    memoryType: string,
    sessionId: string,
    userMessageDateTime: Date,
    fileUploads: IFileUpload[],
    incomingInput: ICommonObject,
    nodes: IReactFlowNode[],
    edges: IReactFlowEdge[],
    socketIO?: Server,
    baseURL?: string
) => {
    try {
        const appServer = getRunningExpressApp()
        const streamResults = await buildAgentGraph(chatflow, chatId, sessionId, incomingInput, baseURL, socketIO)
        if (streamResults) {
            const { finalResult, agentReasoning } = streamResults
            const userMessage: Omit<IChatMessage, 'id'> = {
                role: 'userMessage',
                content: incomingInput.question,
                chatflowid: chatflow.id,
                chatType: isInternal ? chatType.INTERNAL : chatType.EXTERNAL,
                chatId,
                memoryType,
                sessionId,
                createdDate: userMessageDateTime,
                fileUploads: incomingInput.uploads ? JSON.stringify(fileUploads) : undefined,
                leadEmail: incomingInput.leadEmail
            }
            await utilAddChatMessage(userMessage)

            const apiMessage: Omit<IChatMessage, 'id' | 'createdDate'> = {
                role: 'apiMessage',
                content: finalResult,
                chatflowid: chatflow.id,
                chatType: isInternal ? chatType.INTERNAL : chatType.EXTERNAL,
                chatId,
                memoryType,
                sessionId
            }
            if (agentReasoning.length) apiMessage.agentReasoning = JSON.stringify(agentReasoning)
            const chatMessage = await utilAddChatMessage(apiMessage)

            await appServer.telemetry.sendTelemetry('prediction_sent', {
                version: await getAppVersion(),
                chatlowId: chatflow.id,
                chatId,
                type: isInternal ? chatType.INTERNAL : chatType.EXTERNAL,
                flowGraph: getTelemetryFlowObj(nodes, edges)
            })

            // Prepare response
            let result: ICommonObject = {}
            result.text = finalResult
            result.question = incomingInput.question
            result.chatId = chatId
            result.chatMessageId = chatMessage?.id
            if (sessionId) result.sessionId = sessionId
            if (memoryType) result.memoryType = memoryType
            if (agentReasoning.length) result.agentReasoning = agentReasoning

            await appServer.telemetry.sendTelemetry('graph_compiled', {
                version: await getAppVersion(),
                graphId: chatflow.id,
                type: isInternal ? chatType.INTERNAL : chatType.EXTERNAL,
                flowGraph: getTelemetryFlowObj(nodes, edges)
            })

            return result
        }
        return undefined
    } catch (e) {
        logger.error('[server]: Error:', e)
        throw new InternalFlowiseError(StatusCodes.INTERNAL_SERVER_ERROR, getErrorMessage(e))
    }
}
