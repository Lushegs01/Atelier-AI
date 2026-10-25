-- Draft commercial pricing. Explicit review is required before setting enabled=true.
insert into public.credit_packages(id,name,credits,amount_kobo,currency,enabled,sort_order) values
 ('a1000000-0000-4000-8000-000000000001','First collection',100,1500000,'NGN',false,1),
 ('a1000000-0000-4000-8000-000000000002','Studio',350,4500000,'NGN',false,2),
 ('a1000000-0000-4000-8000-000000000003','Fashion house',1000,12000000,'NGN',false,3)
on conflict(id) do nothing;
insert into public.generation_price_rules(provider,operation,option_key,credits,provider_model,provider_credits_milli,enabled) values
 ('fashn','photo','default',12,'product-to-model',2000,false),
 ('fashn','try_on','default',12,'tryon-max',2000,false),
 ('fashn','video','5:480p',15,'image-to-video',1000,false),
 ('fashn','video','5:720p',35,'image-to-video',3000,false),
 ('fashn','video','5:1080p',65,'image-to-video',6000,false),
 ('fashn','video','10:480p',25,'image-to-video',2000,false),
 ('fashn','video','10:720p',65,'image-to-video',6000,false),
 ('fashn','video','10:1080p',125,'image-to-video',12000,false),
 -- Qwen GPU money cost is unknown until measured on the selected infrastructure.
 -- Zero FASHN milli-credits means not applicable, never free GPU inference.
 ('qwen','photo','default',12,'Qwen/Qwen-Image-Edit-2511',0,false),
 ('qwen','try_on','default',12,'Qwen/Qwen-Image-Edit-2511',0,false)
on conflict(provider,operation,option_key) do nothing;
