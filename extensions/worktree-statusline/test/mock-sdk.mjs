export function createSdkHost(session, joined = () => {}) {
	let sequence = 0;
	session.disconnect ??= async () => {};
	session.rpc.extensions ??= {
		list: async () => ({ extensions: [{ id: "user:pr-statusline", pid: process.pid }] }),
		disable: async () => { throw new Error("Unexpected extension disable."); },
	};
	return {
		async joinSession(value) {
			joined({
				...value,
				tools: value.tools?.map((definition) => ({
					...definition,
					handler: async (args, invocation = {}) => definition.handler(args, {
						sessionId: session.sessionId, toolName: definition.name,
						arguments: args, toolCallId: `tool-${sequence++}`, ...invocation,
					}),
				})),
			});
			return session;
		},
	};
}
