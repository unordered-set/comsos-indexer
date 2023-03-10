import { URL } from "url";
import { defaultRegistryUrls, RecieveData } from './constants';
import { Chain } from "@chain-registry/types";
import { EndpointType, NetworkManager } from './networkManager';
import { ApiManager, BlockHeader, Tx } from './apiManager';

export class Watcher {
    //chain name and block to start processing from 
    chains: [string, number | undefined][] = [];
    //depolyed chain-registry urls
    registryUrls: string[] = [];
    //data for each chain
    chainData: Map<string, Chain> = new Map();
    networks: Map<string, ApiManager> = new Map();
    callback: (block: Block) => Promise<void> = () => Promise.reject("No callback provided");
    //what kind of data to fetch
    mode: RecieveData = RecieveData.HEADERS;

    //Builder section
    private constructor(
        registryUrls: string[] = defaultRegistryUrls) {
        this.registryUrls = registryUrls;
    }

    static create(registryUrls: string[] = defaultRegistryUrls): Watcher {
        let ind = new Watcher(registryUrls);
        return ind;
    }

    addNetwork(network: string, fromHeight?: number) {
        this.chains.push([network, fromHeight]);
        return this;
    }

    addCustomRpcs(rpcs: [URL, EndpointType][]) { 

    }

    addNetworks(networks: string[], fromHeight?: number) {
        networks.forEach(network => {
            this.chains.push([network, fromHeight]);
        })

        return this;
    }

    recieve(mode: RecieveData, handler: (block: Block) => Promise<void>) {
        this.mode = mode;
        this.callback = handler;

        return this;
    }

    //Execution section
    async run(): Promise<void> {
        await Promise.allSettled(this.chains.map(async ([chain, fromBlock]) => {
            while (true) {
                try {
                    let netManager = await NetworkManager.create(chain, this.registryUrls);
                    let apiManager = new ApiManager(netManager);
                    this.networks.set(chain, apiManager);
                    await this.runNetwork(chain, fromBlock);
                } catch (err) {
                    //todo handle every error type with instanceof
                    console.log(err);
                    await new Promise(res => setTimeout(res, 30000));
                }
            }
        }))
    }

    async composeBlock(chain: string, height: number): Promise<Block> {
        let header, txs;
        let api = this.networks.get(chain)!;

        switch (this.mode) {
            case RecieveData.HEIGHT:
                return { height, chain, txs: [] };
            case RecieveData.HEADERS:
                header = await api.getBlockHeader(height);
                return { header, height, chain, txs: [] };
            case RecieveData.HEADERS_AND_TRANSACTIONS:
                header = await api.getBlockHeader(height);
                txs = await api.getTxsInBlock(height);
                return { header, txs, height, chain }
        }
    }

    async runNetwork(chain: string, fromBlock: number | undefined): Promise<void> {
        let api = this.networks.get(chain)!;
        let lastHeight = fromBlock || 0;
        while (true) {
            let newHeight = await api.getLatestHeight(lastHeight);

            //no new block commited into network
            if (lastHeight == newHeight) {
                await new Promise(res => setTimeout(res, 1000))
                continue;
            }

            let height = lastHeight === 0 ? newHeight : lastHeight + 1
            for (; height <= newHeight; height++) {
                let block = await this.composeBlock(chain, height)
                this.callback(block);
                lastHeight = height;
            }
        }
    }
}

export interface Block {
    chain: string;
    height: number;
    header?: BlockHeader;
    txs: Tx[];
}