abstract class MessageAdapter {
    abstract id: string;
    abstract from: string;
    abstract to: string;
    abstract body: string;
    abstract type: string;
    abstract timestamp: bigint;
    abstract instance: string;
    abstract fileId: number | null;
    abstract fileName: string | null;
    abstract fileType: string | null;
    abstract fileSize: number | null;
    abstract quoteId: string | null;
}

export default MessageAdapter;