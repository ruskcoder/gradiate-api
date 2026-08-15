
class ProgressTracker {
    constructor(res, streaming = false) {
        this.res = res;
        this.streaming = streaming;

        if (this.streaming) {
            this.res.status(200);
            this.res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
            this.res.setHeader('Cache-Control', 'no-cache, no-transform');
            this.res.setHeader('Connection', 'keep-alive');
            this.res.setHeader('X-Accel-Buffering', 'no');

            if (typeof this.res.flushHeaders === 'function') {
                this.res.flushHeaders();
            }
        }
    }

    update(percent, message) {
        if (this.streaming) {
            this.res.write(JSON.stringify({ percent, message }) + '\n\n');
        }
    }

    complete(data) {
        if (this.streaming) {
            this.res.end(JSON.stringify(data));
        } else {
            this.res.json(data);
        }
    }

    error(statusCode, message) {
        const errorResponse = { success: false, status: statusCode, message };
        if (this.streaming) {
            this.res.status(statusCode).end(JSON.stringify(errorResponse));
        } else {
            this.res.status(statusCode).json(errorResponse);
        }
    }
}

export default ProgressTracker;
