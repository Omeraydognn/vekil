// Generated from src/chain/abi.ts (subset used by the public site). Do not edit by hand.
export const vekilPolicyAbi = [
 {
  "type": "function",
  "name": "agent",
  "inputs": [],
  "outputs": [
   {
    "name": "",
    "type": "address",
    "internalType": "address"
   }
  ],
  "stateMutability": "view"
 },
 {
  "type": "function",
  "name": "agentId",
  "inputs": [],
  "outputs": [
   {
    "name": "",
    "type": "uint256",
    "internalType": "uint256"
   }
  ],
  "stateMutability": "view"
 },
 {
  "type": "function",
  "name": "anchorCount",
  "inputs": [],
  "outputs": [
   {
    "name": "",
    "type": "uint64",
    "internalType": "uint64"
   }
  ],
  "stateMutability": "view"
 },
 {
  "type": "function",
  "name": "anchors",
  "inputs": [
   {
    "name": "",
    "type": "uint64",
    "internalType": "uint64"
   }
  ],
  "outputs": [
   {
    "name": "root",
    "type": "bytes32",
    "internalType": "bytes32"
   },
   {
    "name": "fromSeq",
    "type": "uint64",
    "internalType": "uint64"
   },
   {
    "name": "toSeq",
    "type": "uint64",
    "internalType": "uint64"
   },
   {
    "name": "at",
    "type": "uint64",
    "internalType": "uint64"
   }
  ],
  "stateMutability": "view"
 },
 {
  "type": "function",
  "name": "approvals",
  "inputs": [
   {
    "name": "",
    "type": "bytes32",
    "internalType": "bytes32"
   }
  ],
  "outputs": [
   {
    "name": "status",
    "type": "uint8",
    "internalType": "uint8"
   },
   {
    "name": "reasons",
    "type": "uint32",
    "internalType": "uint32"
   },
   {
    "name": "at",
    "type": "uint64",
    "internalType": "uint64"
   },
   {
    "name": "expiresAt",
    "type": "uint64",
    "internalType": "uint64"
   },
   {
    "name": "policyVersion",
    "type": "uint64",
    "internalType": "uint64"
   },
   {
    "name": "worstCase",
    "type": "uint64",
    "internalType": "uint64"
   }
  ],
  "stateMutability": "view"
 },
 {
  "type": "function",
  "name": "counters",
  "inputs": [],
  "outputs": [
   {
    "name": "hourIndex",
    "type": "uint64",
    "internalType": "uint64"
   },
   {
    "name": "dayIndex",
    "type": "uint64",
    "internalType": "uint64"
   },
   {
    "name": "hourCount",
    "type": "uint16",
    "internalType": "uint16"
   },
   {
    "name": "dayCount",
    "type": "uint16",
    "internalType": "uint16"
   },
   {
    "name": "riskUsed",
    "type": "uint64",
    "internalType": "uint64"
   }
  ],
  "stateMutability": "view"
 },
 {
  "type": "function",
  "name": "entryByExitPrefix",
  "inputs": [
   {
    "name": "",
    "type": "bytes15",
    "internalType": "bytes15"
   }
  ],
  "outputs": [
   {
    "name": "",
    "type": "bytes32",
    "internalType": "bytes32"
   }
  ],
  "stateMutability": "view"
 },
 {
  "type": "function",
  "name": "exitRecordedAt",
  "inputs": [
   {
    "name": "",
    "type": "bytes32",
    "internalType": "bytes32"
   }
  ],
  "outputs": [
   {
    "name": "",
    "type": "uint64",
    "internalType": "uint64"
   }
  ],
  "stateMutability": "view"
 },
 {
  "type": "function",
  "name": "getPolicy",
  "inputs": [],
  "outputs": [
   {
    "name": "",
    "type": "tuple",
    "internalType": "struct VekilPolicy.Policy",
    "components": [
     {
      "name": "maxOrderQuote",
      "type": "uint64",
      "internalType": "uint64"
     },
     {
      "name": "dailyRiskBudget",
      "type": "uint64",
      "internalType": "uint64"
     },
     {
      "name": "maxTradesPerHour",
      "type": "uint16",
      "internalType": "uint16"
     },
     {
      "name": "maxTradesPerDay",
      "type": "uint16",
      "internalType": "uint16"
     },
     {
      "name": "minStopBps",
      "type": "uint16",
      "internalType": "uint16"
     },
     {
      "name": "maxStopBps",
      "type": "uint16",
      "internalType": "uint16"
     },
     {
      "name": "maxHoldMin",
      "type": "uint16",
      "internalType": "uint16"
     },
     {
      "name": "feeBps",
      "type": "uint16",
      "internalType": "uint16"
     },
     {
      "name": "slippageBps",
      "type": "uint16",
      "internalType": "uint16"
     },
     {
      "name": "validUntil",
      "type": "uint64",
      "internalType": "uint64"
     }
    ]
   },
   {
    "name": "instIds",
    "type": "string[]",
    "internalType": "string[]"
   },
   {
    "name": "version",
    "type": "uint64",
    "internalType": "uint64"
   },
   {
    "name": "isPaused",
    "type": "bool",
    "internalType": "bool"
   },
   {
    "name": "srcHash",
    "type": "bytes32",
    "internalType": "bytes32"
   }
  ],
  "stateMutability": "view"
 },
 {
  "type": "function",
  "name": "hardMaxDailyRisk",
  "inputs": [],
  "outputs": [
   {
    "name": "",
    "type": "uint64",
    "internalType": "uint64"
   }
  ],
  "stateMutability": "view"
 },
 {
  "type": "function",
  "name": "hardMaxOrderQuote",
  "inputs": [],
  "outputs": [
   {
    "name": "",
    "type": "uint64",
    "internalType": "uint64"
   }
  ],
  "stateMutability": "view"
 },
 {
  "type": "function",
  "name": "lastAnchoredSeq",
  "inputs": [],
  "outputs": [
   {
    "name": "",
    "type": "uint64",
    "internalType": "uint64"
   }
  ],
  "stateMutability": "view"
 },
 {
  "type": "function",
  "name": "orderHashByPrefix",
  "inputs": [
   {
    "name": "",
    "type": "bytes15",
    "internalType": "bytes15"
   }
  ],
  "outputs": [
   {
    "name": "",
    "type": "bytes32",
    "internalType": "bytes32"
   }
  ],
  "stateMutability": "view"
 },
 {
  "type": "function",
  "name": "owner",
  "inputs": [],
  "outputs": [
   {
    "name": "",
    "type": "address",
    "internalType": "address"
   }
  ],
  "stateMutability": "view"
 },
 {
  "type": "function",
  "name": "paused",
  "inputs": [],
  "outputs": [
   {
    "name": "",
    "type": "bool",
    "internalType": "bool"
   }
  ],
  "stateMutability": "view"
 },
 {
  "type": "function",
  "name": "policyVersion",
  "inputs": [],
  "outputs": [
   {
    "name": "",
    "type": "uint64",
    "internalType": "uint64"
   }
  ],
  "stateMutability": "view"
 },
 {
  "type": "function",
  "name": "requestApproval",
  "inputs": [
   {
    "name": "req",
    "type": "tuple",
    "internalType": "struct VekilPolicy.OrderRequest",
    "components": [
     {
      "name": "instId",
      "type": "bytes32",
      "internalType": "bytes32"
     },
     {
      "name": "side",
      "type": "uint8",
      "internalType": "uint8"
     },
     {
      "name": "px",
      "type": "uint64",
      "internalType": "uint64"
     },
     {
      "name": "sz",
      "type": "uint64",
      "internalType": "uint64"
     },
     {
      "name": "stopPx",
      "type": "uint64",
      "internalType": "uint64"
     },
     {
      "name": "tpPx",
      "type": "uint64",
      "internalType": "uint64"
     },
     {
      "name": "timeStopMin",
      "type": "uint32",
      "internalType": "uint32"
     },
     {
      "name": "decisionHash",
      "type": "bytes32",
      "internalType": "bytes32"
     },
     {
      "name": "nonce",
      "type": "bytes32",
      "internalType": "bytes32"
     }
    ]
   }
  ],
  "outputs": [
   {
    "name": "orderHash",
    "type": "bytes32",
    "internalType": "bytes32"
   },
   {
    "name": "reasons",
    "type": "uint32",
    "internalType": "uint32"
   }
  ],
  "stateMutability": "nonpayable"
 },
 {
  "type": "function",
  "name": "verifyEntry",
  "inputs": [
   {
    "name": "index",
    "type": "uint64",
    "internalType": "uint64"
   },
   {
    "name": "entryHash",
    "type": "bytes32",
    "internalType": "bytes32"
   },
   {
    "name": "proof",
    "type": "bytes32[]",
    "internalType": "bytes32[]"
   }
  ],
  "outputs": [
   {
    "name": "",
    "type": "bool",
    "internalType": "bool"
   }
  ],
  "stateMutability": "view"
 },
 {
  "type": "event",
  "name": "OrderApproved",
  "inputs": [
   {
    "name": "orderHash",
    "type": "bytes32",
    "indexed": true,
    "internalType": "bytes32"
   },
   {
    "name": "req",
    "type": "tuple",
    "indexed": false,
    "internalType": "struct VekilPolicy.OrderRequest",
    "components": [
     {
      "name": "instId",
      "type": "bytes32",
      "internalType": "bytes32"
     },
     {
      "name": "side",
      "type": "uint8",
      "internalType": "uint8"
     },
     {
      "name": "px",
      "type": "uint64",
      "internalType": "uint64"
     },
     {
      "name": "sz",
      "type": "uint64",
      "internalType": "uint64"
     },
     {
      "name": "stopPx",
      "type": "uint64",
      "internalType": "uint64"
     },
     {
      "name": "tpPx",
      "type": "uint64",
      "internalType": "uint64"
     },
     {
      "name": "timeStopMin",
      "type": "uint32",
      "internalType": "uint32"
     },
     {
      "name": "decisionHash",
      "type": "bytes32",
      "internalType": "bytes32"
     },
     {
      "name": "nonce",
      "type": "bytes32",
      "internalType": "bytes32"
     }
    ]
   },
   {
    "name": "worstCase",
    "type": "uint64",
    "indexed": false,
    "internalType": "uint64"
   },
   {
    "name": "policyVersion",
    "type": "uint64",
    "indexed": false,
    "internalType": "uint64"
   }
  ],
  "anonymous": false
 }
];
