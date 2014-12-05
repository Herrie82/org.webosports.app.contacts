enyo.kind({
    name: "db8Source",
    kind: "enyo.Source",
    dbService: "palm://com.palm.db",
    _latestRev: 0,   // most recent _rev of any record

    _doRequest: function (method, parameters, success, failure, subscribe) {
        var request = new enyo.ServiceRequest({
            service: this.dbService,
            method: method,
            subscribe: !!subscribe,
            resubscribe: !!subscribe
        });
        request.go(parameters);

        request.response(this.generalSuccess.bind(this, success, failure));
        request.error(this.generalFailure.bind(this, failure));
    },
    generalFailure: function (failure, inSender, inResponse) {
        console.log("Got failure: ", inSender, " did send ", inResponse);
        if (failure) {
            failure();
        }
    },
    // IMNSHO, over time, we should eliminate this method in favor of handlers specific to each request. -DR
    generalSuccess: function (success, failure, inSender, inResponse) {
        console.log("Got success: ", inSender, " did send ", inResponse);
        if (inResponse.returnValue) {
            if (success) {
                if (inResponse.results) {
                    success(inResponse.results); //need to split that up for Models & Collections.
                } else {
                    success(inResponse);
                }
            }
        } else {   // if returnValue is false, would generalSuccess be called?
            if (failure) {
                failure();
            }
        }
    },

    fetch: function(rec, opts) {
        var method,
            subscribe = false,
            parameters;

        if (rec instanceof enyo.Model) {
            parameters = {ids: [rec.get(rec.primaryKey)]};
            method = "get";
            this._doRequest(method, parameters, opts.success, opts.fail, subscribe);
        } else {
        	this._fetchFind(rec, opts);
        }
    },
    _fetchFind: function (rec, opts) {
        //if more than 500 contacts need to implement paging
    	// http://www.openwebosproject.org/docs/developer_reference/data_types/db8#Query
    	// It's okay to call opts.success multiple times, but be sure processing the previous
    	// call has finished before calling again (probably using enyo.job()).
    	var query = {
    		select: opts.select,
    		from: rec.dbKind,
    		where: opts.where,
    		orderBy: opts.orderBy,
    		desc: opts.desc,
    		incDel: opts.incDel,
    		limit: opts.limit,
    		page: opts.page
    	};
        var parameters = {query: query, count: false, watch: false};
        console.log("db8Source fetch", rec, opts, parameters);

        var request = new enyo.ServiceRequest({service: this.dbService, method: "find"});
        request.go(parameters);

        request.response(handleFindResponse.bind(this, opts.success, opts.fail));
        request.error(this.generalFailure.bind(this, opts.fail));

        function handleFindResponse(success, failure, inSender, inResponse) {
        	console.log("fetch (find) handleFindResponse:", inResponse.results.length, "records", inResponse);
        	// Do we need to store inResponse.next so it can be passed as opts.page?
        	// If we set parameters.count=true, can we make use of inResponse.count?
        	
        	for (var i=0; i<inResponse.results.length; ++i) {
        		var rev = inResponse.results[i]._rev;
        		console.log("fetch (find) handleFindResponse   i:", i, "   rev:", rev);
        		if (rev > this._latestRev) {
        			this._latestRev = rev;
            		console.log("fetch (find) handleFindResponse   _latestRev:", this._latestRev);
        		}
        	}

        	// Only records can be passed to the success callback.
        	// Never pass anything PalmBus- or DB8-specific.
        	success(inResponse.results);

        	// If subscriptions worked, we could set watch: true on the find.
        	// This is effectively the same.
        	var watchWhere;
        	if (query.where) {
        		watchWhere = enyo.clone(query.where).push({prop: "_rev", op: ">", val: this._latestRev });
        	} else {
        		watchWhere = [{prop: "_rev", op: ">", val: this._latestRev }];
        	}
        	var watchQuery = enyo.clone(query);
        	watchQuery.where = watchWhere;
        	watchQuery.orderBy = undefined;
//        	watchQuery.incDel = true;
        	var watchRequest = new enyo.ServiceRequest({service: this.dbService, method: "watch", subscribe: false, resubscribe: false});
        	var watchParameters = {query: watchQuery};
        	console.log("db8Source fetch (watch)", watchParameters);
        	watchRequest.go(watchParameters);
        	watchRequest.response(handleNotificationResponse.bind(this, opts.success, opts.fail));
        	watchRequest.error(this.generalFailure.bind(this, opts.fail));
        }
        
        function handleNotificationResponse(success, failure, inSender, inResponse) {
        	console.log("fetch (watch) handleNotificationResponse:", inResponse);
        	if (! inResponse.fired) {   // SuccessResponse
        		console.log("[watch] SuccessResponse. Whoopee.");
        	} else {   // fired => NotificationResponse
        		console.log("NotificationResponse:", inResponse);
        	}
        }
    },
    
    commit: function(rec, opts) {
        var objects;

        if (rec instanceof enyo.Model) {
            objects = [rec.raw()];
        } else {   // enyo.Collection
            objects = rec.raw();
        }

        var request = new enyo.ServiceRequest({ service: this.dbService, method: "merge"});
        request.go({objects: objects});

        request.response(handlePutResponse.bind(this, opts.success, opts.fail));
        request.error(this.generalFailure.bind(this, opts.fail));
        
        function handlePutResponse(success, failure, inSender, inResponse) {
            console.log("commit (merge) handlePutResponse", inResponse);
            var i, j;
        	for (i=0; i<inResponse.results.length; ++i) {
        		var result = inResponse.results[i];

        		for (j=0; j<objects.length; ++j) {
        			if (result.id === objects[j]._id) {
        				console.log("updating", objects[j], "with", result);
        				objects[j]._rev = result.rev;
        				break;
        			}
        		}
        		if (result.rev > this._latestRev) {   // should always be true
        			this._latestRev = result.rev;
            		console.log("commit (merge) handlePutResponse   _latestRev:", this._latestRev);
        		}
        	}
        	// Only records can be passed to the success callback.
        	// Never pass anything PalmBus- or DB8-specific.
        	if (rec instanceof enyo.Model) {
        		success(objects[0]);
        	} else {   // enyo.Collection
        		success(objects);
        	}
        }
    },

    destroy: function(rec, opts) {
        var ids;

        if (rec instanceof enyo.Collection) {
            ids = [];
            rec.records.forEach(function (m) {
                ids.push(m.get(m.primaryKey));
            });
        } else {
            ids = [rec.get(rec.primaryKey)];
        }

        this._doRequest("del", {ids: ids}, opts.success, opts.fail);
    },
    find: function(rec, opts) {
        this._doRequest("find", rec, opts.success, opts.fail);
    },
    getIds: function (n, opts) {
        this._doRequest("reserveIds", {count: n || 1}, opts.success, opts.fail);
    }
});
