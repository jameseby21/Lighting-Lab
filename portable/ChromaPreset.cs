// A preset player, not an installer: shared-renderer frames plus memory-only key reactions.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

internal static class ChromaPreset {
    private static readonly JavaScriptSerializer Json=new JavaScriptSerializer {MaxJsonLength=8*1024*1024};
    private static Dictionary<string,object> Map(object value) {return (Dictionary<string,object>)value;}
    private static object[] Items(object value) {return (object[])value;}
    private static int Number(object value) {return Convert.ToInt32(value);}
    private static Dictionary<string,object> Request(string url,string method,object value) {
        for(int attempt=0;;attempt++)try{return RequestOnce(url,method,value);}
        catch(WebException error){if(attempt>=5||error.Status!=WebExceptionStatus.ConnectFailure||url=="http://localhost:54235/razer/chromasdk")throw;Thread.Sleep(100);}
    }
    private static Dictionary<string,object> RequestOnce(string url,string method,object value) {
        HttpWebRequest request=(HttpWebRequest)WebRequest.Create(url);request.Method=method;
        request.Proxy=null;request.Timeout=3000;request.ReadWriteTimeout=3000;request.KeepAlive=true;
        if(value!=null){byte[] bytes=Encoding.UTF8.GetBytes(Json.Serialize(value));request.ContentType="application/json";request.ContentLength=bytes.Length;using(Stream stream=request.GetRequestStream())stream.Write(bytes,0,bytes.Length);}
        using(WebResponse response=request.GetResponse())using(StreamReader reader=new StreamReader(response.GetResponseStream())){
            string text=reader.ReadToEnd();Dictionary<string,object> result=text.Length==0?new Dictionary<string,object>():Map(Json.DeserializeObject(text));
            if(result.ContainsKey("result")&&Number(result["result"])!=0)throw new IOException("Chroma rejected the request: SDK result "+result["result"]+".");return result;
        }
    }
    private static string Register(){
        var result=Request("http://localhost:54235/razer/chromasdk","POST",new {title="Lighting Lab Portable Preset",description="A single exported keyboard preset",author=new {name="jeby Labs",contact="local"},device_supported=new string[]{"keyboard","mouse"},category="application"});
        Uri uri;if(!result.ContainsKey("uri")||!Uri.TryCreate(Convert.ToString(result["uri"]),UriKind.Absolute,out uri)||!uri.IsLoopback||uri.Scheme!="http"||uri.UserInfo.Length!=0)throw new IOException("Chroma returned an invalid local session address.");return uri.ToString().TrimEnd('/');
    }
    private static double Fade(string mode,double dr,double dc,double age){
        if(age<0||age>2400)return 0;
        if(mode=="reactive")return dr==0&&dc==0?Math.Max(0,1-age/1300):0;
        if(mode=="ripple"){double distance=Math.Sqrt(dr*dr+dc*dc),elapsed=age-distance*110;return elapsed>=0&&elapsed<450?(1-elapsed/450)*Math.Max(.35,1-distance/18):0;}
        if(mode=="waterfall"){double elapsed=age-dr*150;return dr>=0&&Math.Abs(dc)<=.8&&elapsed>=0&&elapsed<420?1-elapsed/420:0;}return 0;
    }
    private sealed class Press {internal string id;internal string mode;internal double time;}
    internal static int Run(string manifestJson,string[] args){
        var manifest=Map(Json.DeserializeObject(manifestJson));var settings=Map(manifest["requested"]);var playback=Map(manifest["playback"]);
        object[] frames=Items(playback["frames"]),keys=Items(playback["keys"]);int frameMs=Number(playback["frameMs"]);
        if(frames.Length==0||frames.Length>1000||frameMs<20||frameMs>200)throw new InvalidDataException("Invalid preset frame sequence.");
        string feedback=Convert.ToString(settings["feedback"]);bool useInput=args.Length==1&&args[0]=="--with-feedback";
        if(args.Length>0&&!useInput)throw new ArgumentException("Use --with-feedback for memory-only keyboard reactions, or no argument for lighting only.");
        if(!useInput&&!Console.IsInputRedirected&&(feedback!="none"||Convert.ToString(settings["keywordFeedback"])!="none")){
            Console.WriteLine("Enable keyboard reactions while this preset is open? Key identities stay in memory, without typed-text logging. [Y/N]");
            useInput=Console.ReadKey(true).Key==ConsoleKey.Y;
        }
        var selected=new HashSet<string>();foreach(object id in Items(settings["anchors"]))selected.Add(Convert.ToString(id));
        var protectedKeys=new HashSet<string>();foreach(object id in Items(settings["protectedAnchors"]))protectedKeys.Add(Convert.ToString(id));
        bool protect=settings.ContainsKey("protectAnchors")&&Convert.ToBoolean(settings["protectAnchors"]);
        var aliases=settings.ContainsKey("inputAliases")?Map(settings["inputAliases"]):new Dictionary<string,object>();
        var keyMap=new Dictionary<string,Dictionary<string,object>>();foreach(object item in keys){var key=Map(item);keyMap[Convert.ToString(key["id"])]=key;}
        var presses=new List<Press>();string session=null;bool stop=false;
        ConsoleCancelEventHandler cancel=delegate(object sender,ConsoleCancelEventArgs e){e.Cancel=true;stop=true;};Console.CancelKeyPress+=cancel;
        using(Audit audit=new Audit()){
            audit.Record("portable-before-sdk",new {manifest=Json.DeserializeObject(manifestJson),inputEnabled=useInput});
            try{
                session=Register();Stopwatch clock=Stopwatch.StartNew();long heartbeat=0;int failures=0;bool activated=false,mouseEnabled=playback.ContainsKey("mouseFrames");
                if(useInput){var map=new Dictionary<int,string>();foreach(object item in keys){var key=Map(item);int vk=Number(key["vk"]);if(vk!=0)map[vk]=Convert.ToString(key["id"]);}
                    PhysicalInput.Start(map,delegate(string id){if(aliases.ContainsKey(id))id=Convert.ToString(aliases[id]);string mode=selected.Contains(id)&&settings.ContainsKey("keywordFeedback")?Convert.ToString(settings["keywordFeedback"]):feedback;if(mode!="none")presses.Add(new Press{id=id,mode=mode,time=clock.Elapsed.TotalMilliseconds});});}
                Console.WriteLine("Razer keyboard detected. Playing the exported setup through Chroma. Keep this preset open; press Ctrl+C to release it.\nIf lights stay unchanged, enable Chroma Apps and give Lighting Lab priority in Synapse. SDK acknowledgement alone cannot verify the LEDs.\nThe background is a repeating exported animation; closing this window returns control to Synapse.");
                while(!stop){
                    double now=clock.Elapsed.TotalMilliseconds;
                    if(useInput)PhysicalInput.Pump();
                    presses.RemoveAll(p=>now-p.time>2400);if(presses.Count>128)presses.RemoveRange(0,presses.Count-128);
                    object[] original=Items(frames[(int)(now/frameMs)%frames.Length]);int[][] canvas=new int[6][];for(int r=0;r<6;r++){var row=Items(original[r]);canvas[r]=new int[22];for(int c=0;c<22;c++)canvas[r][c]=Number(row[c]);}
                    foreach(object item in keys){var key=Map(item);string id=Convert.ToString(key["id"]);if(protectedKeys.Contains(id)||(protect&&selected.Contains(id)))continue;double alpha=0;
                        foreach(Press press in presses){Dictionary<string,object> origin;if(!keyMap.TryGetValue(press.id,out origin))continue;double dr=Convert.ToDouble(key["y"])-Convert.ToDouble(origin["y"]),dc=Convert.ToDouble(key["x"])-Convert.ToDouble(origin["x"]);alpha=Math.Max(alpha,Fade(press.mode,dr,dc,now-press.time));}
                        if(alpha>0){int r=Number(key["row"]),c=Number(key["col"]),color=canvas[r][c],next=0;for(int channel=0;channel<3;channel++){int value=(color>>(channel*8))&255;next|=((int)Math.Floor(value+(255-value)*alpha+.5))<<(channel*8);}canvas[r][c]=next;}
                    }
                    try{
                        if(clock.ElapsedMilliseconds-heartbeat>=1500){Request(session+"/heartbeat","PUT",null);heartbeat=clock.ElapsedMilliseconds;}
                        var frame=new {effect="CHROMA_CUSTOM",param=canvas};
                        if(!activated){var created=Request(session+"/keyboard","POST",frame);if(!created.ContainsKey("id"))throw new IOException("Chroma did not return an effect identifier.");Request(session+"/effect","PUT",new {id=Convert.ToString(created["id"])});activated=true;}
                        else Request(session+"/keyboard","PUT",frame);
                        if(mouseEnabled)try{var mouse=Items(playback["mouseFrames"]);Request(session+"/mouse","PUT",new {effect="CHROMA_CUSTOM2",param=mouse[(int)(now/frameMs)%mouse.Length]});}
                        catch(Exception error){mouseEnabled=false;audit.Record("mouse-unavailable",new {error=error.Message});Console.WriteLine("Keyboard continues; mouse sync unavailable: "+error.Message);}
                        failures=0;
                    }
                    catch(Exception error){audit.Record("sdk-failed",new {error=error.Message});if(++failures>=2)throw;Thread.Sleep(200);}
                    Thread.Sleep(frameMs);
                }
            }finally{PhysicalInput.Stop();Console.CancelKeyPress-=cancel;if(session!=null)try{Request(session,"DELETE",null);}catch(Exception error){audit.Record("release-failed",new {error=error.Message});}}
        }
        return 0;
    }
    internal static bool HasVendor(ushort vendor,ushort product,bool keyboard){return HidDiscovery.HasDevice(vendor,product,keyboard);}
    internal static int SelfTest(string manifestJson){
        if(Fade("reactive",0,0,0)!=1||Fade("reactive",0,0,1300)!=0||Fade("reactive",0,1,0)!=0||Fade("ripple",0,1,110)<.9||Fade("waterfall",1,.25,150)!=1)throw new Exception("Portable feedback compositor failed.");
        var map=new Dictionary<int,string>{{81,"Q"}};
        if(PhysicalInput.Identity(46,0x53,false,map)!="NUM_DECIMAL"||PhysicalInput.Identity(13,0x1c,true,map)!="NUM_ENTER"||PhysicalInput.Identity(13,0x1c,false,map)!="ENTER"||PhysicalInput.Identity(45,0x52,false,map)!="NUM_0"||PhysicalInput.Identity(81,0x10,false,map)!="Q")throw new Exception("Portable physical key identity failed.");
        int checks=10;var manifest=Map(Json.DeserializeObject(manifestJson));
        if(Number(manifest["schemaVersion"])==2){
            var playback=Map(manifest["playback"]);foreach(object item in Items(playback["frames"])){var rows=Items(item);if(rows.Length!=6)throw new Exception("Invalid portable frame height.");foreach(object row in rows){if(Items(row).Length!=22)throw new Exception("Invalid portable frame width.");checks++;}}
        }
        return checks;
    }
}
